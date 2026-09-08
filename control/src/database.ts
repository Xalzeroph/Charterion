import { existsSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ControlDatabase {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  health(): { ok: boolean; quickCheck: string[]; foreignKeyViolations: number } {
    const quickCheck = (this.db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[]).flatMap((row) => Object.values(row).map(String));
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
    return { ok: quickCheck.length === 1 && quickCheck[0] === 'ok' && foreignKeys.length === 0, quickCheck, foreignKeyViolations: foreignKeys.length };
  }

  checkpoint(mode: 'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE' = 'FULL'): Record<string, number> {
    const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as Record<string, unknown> | undefined;
    if (!row) throw new Error('SQLite checkpoint returned no result');
    const values = Object.values(row).map(Number);
    if (values.length < 3 || values.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('SQLite checkpoint returned an invalid result');
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  }

  backupTo(destination: string, options: { authorizedRoot?: string } = {}): { path: string; health: { ok: boolean; quickCheck: string[]; foreignKeyViolations: number } } {
    const target = resolve(destination);
    const root = resolve(options.authorizedRoot ?? dirname(this.path));
    const rel = relative(root, target);
    if (!isAbsolute(target) || !rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Database backup destination is outside the authorized root');
    if (target.toLowerCase() === resolve(this.path).toLowerCase()) throw new Error('Database backup destination must differ from the live database');
    if (existsSync(target)) throw new Error('Database backup destination already exists');
    mkdirSync(dirname(target), { recursive: true });
    this.checkpoint('FULL');
    const escaped = target.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
    const backup = new ControlDatabase(target);
    try {
      const health = backup.health();
      if (!health.ok) throw new Error('Database backup verification failed');
      return { path: target, health };
    } finally { backup.close(); }
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* keep original error */ }
      throw error;
    }
  }
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    const migrations = controlMigrationVersions();
    const supportedVersion = migrations.at(-1) ?? 0;
    if (supportedVersion < 1) throw new Error('Control database has no registered migrations');
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version') as { value?: string } | undefined;
    const version = row?.value ? Number(row.value) : 0;
    if (!Number.isInteger(version) || version < 0) throw new Error('Control database schema version is invalid');
    if (version > supportedVersion) {
      throw new Error(`Control database schema ${version} is newer than supported ${supportedVersion}`);
    }
    for (const migrationVersion of migrations) {
      if (version >= migrationVersion) continue;
      const name = `migrateV${migrationVersion}`;
      const migration = (this as unknown as Record<string, unknown>)[name];
      if (typeof migration !== 'function') throw new Error(`Control database migration ${name} is missing`);
      (migration as () => void).call(this);
    }
    this.db.prepare(`
      INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(supportedVersion));
  }

  private migrateV1(): void {
    this.transaction(() => {
      this.createCoreTables();
      this.createLeaseTables();
      this.createCapabilityTables();
      this.createEventTables();
    });
  }

  private migrateV2(): void {
    this.transaction(() => this.createEvidenceTables());
  }

  private migrateV3(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(claims)').all();
      if (!columns.some((row) => row.name === 'lease_id')) {
        this.db.exec('ALTER TABLE claims ADD COLUMN lease_id TEXT REFERENCES leases(id) ON DELETE RESTRICT;');
      }
    });
  }

  private createEvidenceTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        attempt_id TEXT,
        subject TEXT NOT NULL,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
        lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0),
        summary TEXT NOT NULL,
        commit_sha TEXT,
        status TEXT NOT NULL CHECK(status IN ('submitted','verified','rejected')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_claims_project_task ON claims(project_id, task_id, created_at);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('file','test-log','report','git-bundle','other')),
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(claim_id, relative_path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_artifacts_claim ON artifacts(claim_id, created_at);

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('passed','failed')),
        checks_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_verifications_claim ON verifications(claim_id, created_at);
    `);
  }
  private migrateV4(): void {
    this.transaction(() => this.createChangeRequestTables());
  }

  private createChangeRequestTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_requests (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, author_subject TEXT NOT NULL, branch TEXT NOT NULL, base_sha TEXT NOT NULL, head_sha TEXT NOT NULL,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE RESTRICT, revision INTEGER NOT NULL CHECK(revision > 0),
        status TEXT NOT NULL CHECK(status IN ('open','changes-requested','approved','queued','integrated','closed')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_change_requests_project_task ON change_requests(project_id,task_id,created_at);

      CREATE TABLE IF NOT EXISTS change_request_revisions (
        id TEXT PRIMARY KEY, change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0), claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
        head_sha TEXT NOT NULL, submitted_at INTEGER NOT NULL, UNIQUE(change_request_id,revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS supervisor_reviews (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE, reviewer_subject TEXT NOT NULL,
        head_sha TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('approve','request-changes')), body TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_reviews_change_request ON supervisor_reviews(change_request_id,created_at);
      CREATE TABLE IF NOT EXISTS merge_queue (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE, head_sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','validating','integrated','failed','cancelled')),
        queued_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, integrated_sha TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_merge_queue_project_status ON merge_queue(project_id,status,queued_at);
    `);
  }

  private migrateV5(): void {
    this.transaction(() => {
      const crColumns = this.db.prepare('PRAGMA table_info(change_requests)').all();
      if (!crColumns.some((row) => row.name === 'target_branch')) this.db.exec("ALTER TABLE change_requests ADD COLUMN target_branch TEXT NOT NULL DEFAULT 'main';");
      const queueColumns = this.db.prepare('PRAGMA table_info(merge_queue)').all();
      if (!queueColumns.some((row) => row.name === 'target_branch')) this.db.exec("ALTER TABLE merge_queue ADD COLUMN target_branch TEXT NOT NULL DEFAULT 'main';");
      if (!queueColumns.some((row) => row.name === 'candidate_base_sha')) this.db.exec('ALTER TABLE merge_queue ADD COLUMN candidate_base_sha TEXT;');
      if (!queueColumns.some((row) => row.name === 'candidate_sha')) this.db.exec('ALTER TABLE merge_queue ADD COLUMN candidate_sha TEXT;');
    });
  }

  private migrateV6(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS browser_runtime (
          profile_id TEXT PRIMARY KEY,
          auth_status TEXT NOT NULL CHECK(auth_status IN ('unknown','authenticated','authentication-required')),
          page_health TEXT NOT NULL DEFAULT 'unknown' CHECK(page_health IN ('unknown','ready','generating','blocked','error','unavailable')),
          open_tabs INTEGER NOT NULL CHECK(open_tabs >= 0),
          extension_version TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        ) STRICT;
      `);
    });
  }
  private migrateV7(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(agent_slots)').all();
      if (!columns.some((row) => row.name === 'desired_state')) this.db.exec("ALTER TABLE agent_slots ADD COLUMN desired_state TEXT NOT NULL DEFAULT 'active' CHECK(desired_state IN ('active','suspended','retired'));");
      if (!columns.some((row) => row.name === 'browser_state')) this.db.exec("ALTER TABLE agent_slots ADD COLUMN browser_state TEXT NOT NULL DEFAULT 'absent' CHECK(browser_state IN ('absent','opening','open','closing','error'));");
      if (!columns.some((row) => row.name === 'browser_profile_id')) this.db.exec('ALTER TABLE agent_slots ADD COLUMN browser_profile_id TEXT;');
      if (!columns.some((row) => row.name === 'browser_tab_id')) this.db.exec('ALTER TABLE agent_slots ADD COLUMN browser_tab_id INTEGER;');
      if (!columns.some((row) => row.name === 'browser_error')) this.db.exec('ALTER TABLE agent_slots ADD COLUMN browser_error TEXT;');
      if (!columns.some((row) => row.name === 'browser_observed_at')) this.db.exec('ALTER TABLE agent_slots ADD COLUMN browser_observed_at INTEGER;');
    });
  }
  private migrateV8(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS worker_requests (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id TEXT,
          from_subject TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('suggestion','blocker','question','resource-request','scope-change','dependency-request','cross-system-request','review-request','risk-alert','worker-request')),
          title TEXT NOT NULL, body TEXT NOT NULL, suggested_action TEXT,
          status TEXT NOT NULL CHECK(status IN ('open','accepted','rejected','resolved')),
          decided_by TEXT, decision_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_worker_requests_project_status ON worker_requests(project_id,status,created_at);
      `);
    });
  }
  private migrateV9(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(capabilities)').all();
      if (!columns.some((row) => row.name === 'agent_slot_id')) this.db.exec('ALTER TABLE capabilities ADD COLUMN agent_slot_id TEXT REFERENCES agent_slots(id) ON DELETE CASCADE;');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_capabilities_agent_slot ON capabilities(agent_slot_id, expires_at);');
    });
  }
  private migrateV10(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(browser_runtime)').all();
      if (!columns.some((row) => row.name === 'page_health')) {
        this.db.exec("ALTER TABLE browser_runtime ADD COLUMN page_health TEXT NOT NULL DEFAULT 'unknown' CHECK(page_health IN ('unknown','ready','generating','blocked','error','unavailable'));");
      }
    });
  }
  private migrateV11(): void {
    this.transaction(() => this.createManagerWorkTables());
  }

  private migrateV12(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(agent_slots)').all();
      const add = (name: string, sql: string): void => { if (!columns.some((row) => row.name === name)) this.db.exec(sql); };
      add('browser_lease_id', 'ALTER TABLE agent_slots ADD COLUMN browser_lease_id TEXT;');
      add('browser_lease_epoch', 'ALTER TABLE agent_slots ADD COLUMN browser_lease_epoch INTEGER;');
      add('browser_content_epoch', 'ALTER TABLE agent_slots ADD COLUMN browser_content_epoch TEXT;');
      add('browser_observation_revision', 'ALTER TABLE agent_slots ADD COLUMN browser_observation_revision INTEGER;');
      add('browser_page_status', 'ALTER TABLE agent_slots ADD COLUMN browser_page_status TEXT;');
      add('browser_runtime_observed_at', 'ALTER TABLE agent_slots ADD COLUMN browser_runtime_observed_at INTEGER;');
      add('browser_quarantined', 'ALTER TABLE agent_slots ADD COLUMN browser_quarantined INTEGER NOT NULL DEFAULT 0 CHECK(browser_quarantined IN (0,1));');
      add('browser_quarantine_reason', 'ALTER TABLE agent_slots ADD COLUMN browser_quarantine_reason TEXT;');
      this.createBrowserAuthorityTables();
    });
  }

  private migrateV13(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(agent_slots)').all();
      const add = (name: string, sql: string): void => { if (!columns.some((row) => row.name === name)) this.db.exec(sql); };
      add('conversation_generation', 'ALTER TABLE agent_slots ADD COLUMN conversation_generation INTEGER NOT NULL DEFAULT 0 CHECK(conversation_generation >= 0);');
      add('rollover_state', "ALTER TABLE agent_slots ADD COLUMN rollover_state TEXT NOT NULL DEFAULT 'idle' CHECK(rollover_state IN ('idle','requested','opening','bootstrapping'));");
      add('active_rollover_id', 'ALTER TABLE agent_slots ADD COLUMN active_rollover_id TEXT;');
      this.createConversationContinuityTables();
      this.db.exec("UPDATE agent_slots SET conversation_generation=1 WHERE conversation_key IS NOT NULL AND conversation_generation=0;");
      this.db.exec("INSERT OR IGNORE INTO agent_conversations(id,project_id,slot_id,generation,conversation_key,status,predecessor_conversation_key,started_at,ended_at,close_reason) SELECT 'legacy:'||id,project_id,id,conversation_generation,conversation_key,'active',NULL,updated_at,NULL,NULL FROM agent_slots WHERE conversation_key IS NOT NULL;");
    });
  }

  private migrateV14(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_workspaces (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, task_id TEXT NOT NULL,
          slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE, repo_path TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base_sha TEXT NOT NULL,
          resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE, lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0),
          capability_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE, capability_token_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','released')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(project_id,task_id), UNIQUE(path)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_task_workspaces_slot_status ON task_workspaces(slot_id,status,created_at);
      `);
    });
  }

  private migrateV15(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS self_hosting_promotions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE RESTRICT,
          candidate_subject TEXT NOT NULL,
          candidate_sha TEXT NOT NULL,
          target_ref TEXT NOT NULL,
          expected_parent_sha TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','promoted')),
          decision_by TEXT,
          decision_reason TEXT,
          decision_at INTEGER,
          promoted_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id,idempotency_key)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_self_hosting_promotions_project_status
          ON self_hosting_promotions(project_id,status,created_at);
      `);
    });
  }
  private migrateV16(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','archived')),
          purpose TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS departments (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('active','archived')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(organization_id,name)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS organization_domains (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE RESTRICT, name TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('active','archived')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(department_id,name)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS organization_agents (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          display_name TEXT NOT NULL, primary_department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
          runtime_slot_id TEXT UNIQUE REFERENCES agent_slots(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK(status IN ('active','suspended','retired')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_organization_agents_org_status ON organization_agents(organization_id,status,created_at);
        CREATE TABLE IF NOT EXISTS agent_domain_assignments (
          agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          domain_id TEXT NOT NULL REFERENCES organization_domains(id) ON DELETE CASCADE,
          responsibility TEXT NOT NULL CHECK(responsibility IN ('primary','secondary')), assigned_at INTEGER NOT NULL,
          PRIMARY KEY(agent_id,domain_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS missions (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, title TEXT NOT NULL, objective TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('proposed','active','blocked','completed','cancelled')),
          dri_agent_id TEXT REFERENCES organization_agents(id) ON DELETE SET NULL, source_request_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_missions_org_status ON missions(organization_id,status,created_at);
        CREATE TABLE IF NOT EXISTS mission_members (
          mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('contributor','reviewer','advisor','observer')), joined_at INTEGER NOT NULL,
          PRIMARY KEY(mission_id,agent_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS organization_work_items (
          id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
          title TEXT NOT NULL, objective TEXT NOT NULL, owner_agent_id TEXT REFERENCES organization_agents(id) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK(status IN ('proposed','ready','active','blocked','completed','cancelled')),
          depends_on_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_organization_work_mission_status ON organization_work_items(mission_id,status,created_at);
        CREATE TABLE IF NOT EXISTS work_requests (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          requester_kind TEXT NOT NULL CHECK(requester_kind IN ('human','external-ai','internal-agent','system')),
          requester_identity TEXT NOT NULL, objective TEXT NOT NULL, context_refs_json TEXT NOT NULL,
          constraints_json TEXT NOT NULL, desired_outputs_json TEXT NOT NULL,
          priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')), deadline INTEGER,
          idempotency_key TEXT, request_digest TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('received','accepted','rejected','cancelled')),
          mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL, decision_by TEXT, decision_reason TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_requests_idempotency
          ON work_requests(organization_id,requester_kind,requester_identity,idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_work_requests_org_status ON work_requests(organization_id,status,created_at);
        CREATE TABLE IF NOT EXISTS work_outcomes (
          work_item_id TEXT PRIMARY KEY REFERENCES organization_work_items(id) ON DELETE CASCADE,
          disposition TEXT NOT NULL CHECK(disposition IN ('completed','cancelled')), summary TEXT NOT NULL,
          produced_refs_json TEXT NOT NULL, decision_refs_json TEXT NOT NULL, blocker_refs_json TEXT NOT NULL,
          completed_at INTEGER NOT NULL
        ) STRICT;
      `);
    });
  }

  private migrateV17(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_workspaces (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL CHECK(generation > 0),
          isolation_tier TEXT NOT NULL CHECK(isolation_tier IN ('c0-host','c1-container','c2-hypervisor','c3-ephemeral-vm')),
          backend_kind TEXT CHECK(backend_kind IS NULL OR backend_kind IN ('host','container','hypervisor-vm','ephemeral-vm','remote-host')),
          root_ref TEXT,
          browser_profile_id TEXT,
          tool_profile_ref TEXT,
          endpoint_refs_json TEXT NOT NULL DEFAULT '[]',
          mounted_resource_refs_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL CHECK(status IN ('provisioning','ready','suspended','error','retired')),
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(agent_id,generation)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspaces_one_live
          ON agent_workspaces(agent_id) WHERE status IN ('provisioning','ready','suspended','error');
        CREATE INDEX IF NOT EXISTS idx_agent_workspaces_org_status ON agent_workspaces(organization_id,status,created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspaces_browser_profile_live
          ON agent_workspaces(browser_profile_id) WHERE browser_profile_id IS NOT NULL AND status<>'retired';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_workspaces_tool_profile_live
          ON agent_workspaces(tool_profile_ref) WHERE tool_profile_ref IS NOT NULL AND status<>'retired';
      `);
    });
  }
  private migrateV18(): void {
    const columns = this.db.prepare('PRAGMA table_info(agent_workspaces)').all() as Array<{ name: string }>;
    if (columns.some((row) => row.name === 'security_mode')) return;
    this.transaction(() => {
      this.db.exec(`
        ALTER TABLE agent_workspaces RENAME TO agent_workspaces_v17;
        CREATE TABLE agent_workspaces (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL CHECK(generation > 0),
          security_mode TEXT NOT NULL CHECK(security_mode IN ('prompt-guarded','tool-scoped','sandboxed')),
          root_ref TEXT,
          browser_profile_id TEXT,
          tool_profile_ref TEXT,
          endpoint_refs_json TEXT NOT NULL DEFAULT '[]',
          allowed_refs_json TEXT NOT NULL DEFAULT '[]',
          forbidden_refs_json TEXT NOT NULL DEFAULT '[]',
          workspace_charter_version TEXT NOT NULL,
          workspace_charter_digest TEXT NOT NULL,
          dangerous_action_policy TEXT NOT NULL CHECK(dangerous_action_policy IN ('approval-required','deny')),
          tool_policy_state TEXT NOT NULL CHECK(tool_policy_state IN ('unconfigured','configured','unsupported')),
          status TEXT NOT NULL CHECK(status IN ('configuring','ready','suspended','error','retired')),
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(agent_id,generation)
        ) STRICT;
        INSERT INTO agent_workspaces(
          id,organization_id,agent_id,generation,security_mode,root_ref,browser_profile_id,tool_profile_ref,
          endpoint_refs_json,allowed_refs_json,forbidden_refs_json,workspace_charter_version,workspace_charter_digest,
          dangerous_action_policy,tool_policy_state,status,error,created_at,updated_at
        ) SELECT
          id,organization_id,agent_id,generation,
          CASE WHEN backend_kind IN ('container','hypervisor-vm','ephemeral-vm') THEN 'sandboxed' ELSE 'prompt-guarded' END,
          root_ref,browser_profile_id,tool_profile_ref,endpoint_refs_json,mounted_resource_refs_json,'[]',
          'workspace-charter-v2','', 'approval-required','unconfigured',
          CASE WHEN status='provisioning' THEN 'configuring' ELSE status END,error,created_at,updated_at
        FROM agent_workspaces_v17;
        DROP TABLE agent_workspaces_v17;
        CREATE UNIQUE INDEX idx_agent_workspaces_one_live
          ON agent_workspaces(agent_id) WHERE status IN ('configuring','ready','suspended','error');
        CREATE INDEX idx_agent_workspaces_org_status ON agent_workspaces(organization_id,status,created_at);
        CREATE UNIQUE INDEX idx_agent_workspaces_browser_profile_live
          ON agent_workspaces(browser_profile_id) WHERE browser_profile_id IS NOT NULL AND status<>'retired';
        CREATE UNIQUE INDEX idx_agent_workspaces_tool_profile_live
          ON agent_workspaces(tool_profile_ref) WHERE tool_profile_ref IS NOT NULL AND status<>'retired';
      `);
    });
  }
  private migrateV19(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS organization_agent_conversations (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL CHECK(generation > 0),
          conversation_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK(status IN ('active','closed')),
          predecessor_conversation_key TEXT,
          runtime_slot_id TEXT REFERENCES agent_slots(id) ON DELETE SET NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          close_reason TEXT,
          UNIQUE(agent_id,generation)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_org_agent_conversations_one_active
          ON organization_agent_conversations(agent_id) WHERE status='active';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_org_agent_conversations_runtime_active
          ON organization_agent_conversations(runtime_slot_id) WHERE runtime_slot_id IS NOT NULL AND status='active';
        CREATE INDEX IF NOT EXISTS idx_org_agent_conversations_agent
          ON organization_agent_conversations(agent_id,generation);
      `);
    });
  }
  private migrateV20(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
          scope_key TEXT NOT NULL,
          domain_id TEXT REFERENCES organization_domains(id) ON DELETE SET NULL,
          fingerprint TEXT NOT NULL,
          title TEXT NOT NULL,
          symptom TEXT NOT NULL,
          locations_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL CHECK(status IN ('open','owned','in-progress','resolved','rejected')),
          owning_department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
          owning_agent_id TEXT REFERENCES organization_agents(id) ON DELETE SET NULL,
          mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(organization_id,scope_key,fingerprint)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_findings_org_status ON findings(organization_id,status,created_at);
        CREATE INDEX IF NOT EXISTS idx_findings_owner ON findings(owning_agent_id,status,updated_at);
        CREATE TABLE IF NOT EXISTS finding_evidence (
          id TEXT PRIMARY KEY,
          finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
          observer_subject TEXT NOT NULL,
          evidence_refs_json TEXT NOT NULL DEFAULT '[]',
          note TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_finding_evidence_finding ON finding_evidence(finding_id,created_at);
      `);
    });
  }

  private migrateV21(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS review_requests (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          change_request_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK(revision > 0),
          head_sha TEXT NOT NULL,
          author_subject TEXT NOT NULL,
          risk TEXT NOT NULL CHECK(risk IN ('low','normal','high','critical')),
          status TEXT NOT NULL CHECK(status IN ('open','approved','changes-requested','rejected','superseded')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(change_request_id,revision)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_review_requests_org_status ON review_requests(organization_id,status,created_at);
        CREATE TABLE IF NOT EXISTS review_slots (
          id TEXT PRIMARY KEY,
          review_request_id TEXT NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
          dimension TEXT NOT NULL,
          required INTEGER NOT NULL CHECK(required IN (0,1)),
          required_domain_id TEXT REFERENCES organization_domains(id) ON DELETE SET NULL,
          state TEXT NOT NULL CHECK(state IN ('open','claimed','approved','changes-requested','rejected')),
          reviewer_agent_id TEXT REFERENCES organization_agents(id) ON DELETE SET NULL,
          claimed_at INTEGER,
          decided_at INTEGER,
          decision_note TEXT,
          UNIQUE(review_request_id,dimension,required_domain_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_review_slots_state ON review_slots(state,review_request_id);
        CREATE INDEX IF NOT EXISTS idx_review_slots_reviewer ON review_slots(reviewer_agent_id,state);
      `);
    });
  }

  private migrateV22(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS organization_runtime_acquisitions (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('requested','acquiring','acquired','released','failed')),
          runtime_slot_id TEXT REFERENCES agent_slots(id) ON DELETE SET NULL,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(organization_id,idempotency_key)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_org_runtime_acquisition_one_live_agent
          ON organization_runtime_acquisitions(agent_id) WHERE status IN ('requested','acquiring','acquired');
        CREATE INDEX IF NOT EXISTS idx_org_runtime_acquisition_project_status
          ON organization_runtime_acquisitions(project_id,status,created_at);
      `);
    });
  }

  private migrateV23(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_org_runtime_acquisition_acquired_slot
        BEFORE INSERT ON organization_runtime_acquisitions
        WHEN NEW.status='acquired' AND NEW.runtime_slot_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime acquisition requires a runtime slot');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_org_runtime_acquisition_acquired_slot_update
        BEFORE UPDATE OF status,runtime_slot_id ON organization_runtime_acquisitions
        WHEN NEW.status='acquired' AND NEW.runtime_slot_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime acquisition requires a runtime slot');
        END;
      `);
    });
  }

  private migrateV24(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_org_runtime_acquisition_intent
        BEFORE INSERT ON organization_runtime_acquisitions
        WHEN NEW.status='acquired'
          AND NEW.runtime_slot_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_slots
          WHERE id=NEW.runtime_slot_id
            AND project_id=NEW.project_id
            AND role=NEW.role
            AND status<>'retired'
        )
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime slot does not match project and role intent');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_org_runtime_acquisition_intent_update
        BEFORE UPDATE OF status,runtime_slot_id,project_id,role ON organization_runtime_acquisitions
        WHEN NEW.status='acquired'
          AND NEW.runtime_slot_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_slots
          WHERE id=NEW.runtime_slot_id
            AND project_id=NEW.project_id
            AND role=NEW.role
            AND status<>'retired'
        )
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime slot does not match project and role intent');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_org_runtime_acquisition_binding
        BEFORE INSERT ON organization_runtime_acquisitions
        WHEN NEW.status='acquired'
          AND EXISTS (
            SELECT 1 FROM agent_slots
            WHERE id=NEW.runtime_slot_id
              AND project_id=NEW.project_id
              AND role=NEW.role
              AND status<>'retired'
          )
          AND NOT EXISTS (
            SELECT 1 FROM organization_agents
            WHERE id=NEW.agent_id
              AND organization_id=NEW.organization_id
              AND runtime_slot_id=NEW.runtime_slot_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime slot is not bound to the Organization Agent');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_org_runtime_acquisition_binding_update
        BEFORE UPDATE OF status,runtime_slot_id,agent_id,organization_id ON organization_runtime_acquisitions
        WHEN NEW.status='acquired'
          AND EXISTS (
            SELECT 1 FROM agent_slots
            WHERE id=NEW.runtime_slot_id
              AND project_id=NEW.project_id
              AND role=NEW.role
              AND status<>'retired'
          )
          AND NOT EXISTS (
            SELECT 1 FROM organization_agents
            WHERE id=NEW.agent_id
              AND organization_id=NEW.organization_id
              AND runtime_slot_id=NEW.runtime_slot_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime slot is not bound to the Organization Agent');
        END;
      `);
    });
  }

  private migrateV25(): void {
    this.transaction(() => {
      this.db.exec(`
        DROP TRIGGER IF EXISTS trg_org_runtime_acquisition_binding;
        DROP TRIGGER IF EXISTS trg_org_runtime_acquisition_binding_update;
        CREATE TRIGGER trg_org_runtime_acquisition_binding
        BEFORE INSERT ON organization_runtime_acquisitions
        WHEN NEW.status='acquired'
          AND EXISTS (
            SELECT 1 FROM agent_slots
            WHERE id=NEW.runtime_slot_id
              AND project_id=NEW.project_id
              AND role=NEW.role
              AND status<>'retired'
          )
          AND NOT EXISTS (
            SELECT 1 FROM organization_agents
            WHERE id=NEW.agent_id
              AND organization_id=NEW.organization_id
              AND runtime_slot_id=NEW.runtime_slot_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime slot is not bound to the Organization Agent');
        END;
        CREATE TRIGGER trg_org_runtime_acquisition_binding_update
        BEFORE UPDATE OF status,runtime_slot_id,agent_id,organization_id ON organization_runtime_acquisitions
        WHEN NEW.status='acquired'
          AND EXISTS (
            SELECT 1 FROM agent_slots
            WHERE id=NEW.runtime_slot_id
              AND project_id=NEW.project_id
              AND role=NEW.role
              AND status<>'retired'
          )
          AND NOT EXISTS (
            SELECT 1 FROM organization_agents
            WHERE id=NEW.agent_id
              AND organization_id=NEW.organization_id
              AND runtime_slot_id=NEW.runtime_slot_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'Acquired runtime slot is not bound to the Organization Agent');
        END;
      `);
    });
  }

  private migrateV26(): void {
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(organization_work_items)').all() as Array<{ name?: string }>;
      if (!columns.some((column) => column.name === 'completion_policy')) {
        this.db.exec("ALTER TABLE organization_work_items ADD COLUMN completion_policy TEXT NOT NULL DEFAULT 'verified-claim' CHECK(completion_policy IN ('structured-result','verified-claim'))");
      }
    });
  }

  private migrateV27(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS organization_review_work_items (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
          review_request_id TEXT NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
          review_slot_id TEXT NOT NULL REFERENCES review_slots(id) ON DELETE CASCADE,
          work_item_id TEXT NOT NULL REFERENCES organization_work_items(id) ON DELETE CASCADE,
          reviewer_agent_id TEXT NOT NULL REFERENCES organization_agents(id) ON DELETE CASCADE,
          runtime_acquisition_id TEXT NOT NULL REFERENCES organization_runtime_acquisitions(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK(status IN ('materialized','claimed','decided','completed','blocked')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(review_slot_id), UNIQUE(work_item_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_org_review_work_items_request ON organization_review_work_items(review_request_id,status);
        CREATE INDEX IF NOT EXISTS idx_org_review_work_items_reviewer ON organization_review_work_items(reviewer_agent_id,status);
      `);
    });
  }

  private createConversationContinuityTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK(generation > 0), conversation_key TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','closed')),
        predecessor_conversation_key TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, close_reason TEXT,
        UNIQUE(slot_id,generation), UNIQUE(project_id,conversation_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_slot ON agent_conversations(slot_id,generation);
      CREATE TABLE IF NOT EXISTS worker_checkpoints (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, handoff_text TEXT NOT NULL, state_json TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_worker_checkpoints_slot ON worker_checkpoints(slot_id,created_at);
      CREATE TABLE IF NOT EXISTS agent_rollovers (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, slot_id TEXT NOT NULL REFERENCES agent_slots(id) ON DELETE CASCADE,
        from_conversation_key TEXT NOT NULL, to_conversation_key TEXT, from_generation INTEGER NOT NULL CHECK(from_generation > 0), to_generation INTEGER NOT NULL CHECK(to_generation > from_generation),
        checkpoint_id TEXT NOT NULL REFERENCES worker_checkpoints(id) ON DELETE RESTRICT, status TEXT NOT NULL CHECK(status IN ('requested','opening','bootstrapping','completed','failed')),
        reason TEXT NOT NULL, bootstrap_attempt_id TEXT, error TEXT, requested_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_agent_rollovers_slot ON agent_rollovers(slot_id,requested_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rollovers_active ON agent_rollovers(slot_id) WHERE status IN ('requested','opening','bootstrapping');
    `);
  }

  private createBrowserAuthorityTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_operations (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, operation TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, slot_id TEXT REFERENCES agent_slots(id) ON DELETE CASCADE,
        conversation_key TEXT, tab_id INTEGER, content_epoch TEXT, preconditions_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('planned','dispatched','settled')),
        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('acknowledged','reply-observed','failed','uncertain')),
        evidence_json TEXT NOT NULL DEFAULT '{}', planned_at INTEGER NOT NULL, dispatched_at INTEGER, settled_at INTEGER, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_browser_operations_slot_state ON browser_operations(slot_id,state,updated_at);
      CREATE TABLE IF NOT EXISTS runtime_incidents (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('warning','error','critical')),
        code TEXT NOT NULL, subject TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_runtime_incidents_open ON runtime_incidents(resolved_at,created_at);
      CREATE TABLE IF NOT EXISTS manager_work_mutations (
        message_id TEXT PRIMARY KEY, generation TEXT NOT NULL, sequence INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        result_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(generation,sequence)
      ) STRICT;
    `);
  }

  private createManagerWorkTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manager_work_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO manager_work_meta(singleton,revision,updated_at) VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS manager_tasks (id TEXT PRIMARY KEY, position INTEGER NOT NULL, document_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS manager_attempts (id TEXT PRIMARY KEY, position INTEGER NOT NULL, document_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS manager_messages (id TEXT PRIMARY KEY, position INTEGER NOT NULL, document_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_tasks_position ON manager_tasks(position);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_attempts_position ON manager_attempts(position);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_messages_position ON manager_messages(position);
    `);
  }

  private createCoreTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','draining','paused','archived')),
        isolation_tier TEXT NOT NULL,
        min_slots INTEGER NOT NULL CHECK(min_slots >= 0),
        max_slots INTEGER NOT NULL CHECK(max_slots >= min_slots),
        weight INTEGER NOT NULL CHECK(weight > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_slots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('idle','assigned','suspended','retired')),
        desired_state TEXT NOT NULL DEFAULT 'active' CHECK(desired_state IN ('active','suspended','retired')),
        browser_state TEXT NOT NULL DEFAULT 'absent' CHECK(browser_state IN ('absent','opening','open','closing','error')),
        conversation_key TEXT,
        browser_profile_id TEXT,
        browser_tab_id INTEGER,
        browser_error TEXT,
        browser_observed_at INTEGER,
        lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, conversation_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES resources(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_resources_project ON resources(project_id);
    `);
  }

  private createLeaseTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        holder_id TEXT NOT NULL,
        task_id TEXT,
        mode TEXT NOT NULL CHECK(mode IN ('shared','exclusive')),
        epoch INTEGER NOT NULL CHECK(epoch > 0),
        status TEXT NOT NULL CHECK(status IN ('active','released','expired')),
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_leases_resource_status ON leases(resource_id, status);
      CREATE INDEX IF NOT EXISTS idx_leases_holder ON leases(holder_id, status);
    `);
  }

  private createCapabilityTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capabilities (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        subject TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_slot_id TEXT REFERENCES agent_slots(id) ON DELETE CASCADE,
        task_id TEXT,
        lease_epoch INTEGER,
        scopes_json TEXT NOT NULL,
        resource_ids_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_capabilities_project ON capabilities(project_id, expires_at);
    `);
  }
  private createEventTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        subject TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, seq);
    `);
  }
}
function controlMigrationVersions(): number[] {
  const versions = Object.getOwnPropertyNames(ControlDatabase.prototype)
    .flatMap((name) => {
      const match = /^migrateV(\d+)$/.exec(name);
      return match ? [Number(match[1])] : [];
    })
    .sort((left, right) => left - right);
  for (let index = 0; index < versions.length; index += 1) {
    if (versions[index] !== index + 1) throw new Error(`Control database migration chain has a gap before V${index + 1}`);
  }
  return versions;
}

export const CONTROL_SCHEMA_VERSION = controlMigrationVersions().at(-1) ?? 0;
