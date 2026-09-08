import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_VERSION, ControlDatabase } from '../src/database';

describe('control database migrations', () => {
  it('derives the supported schema version from one contiguous migration registry', () => {
    const versions = Object.getOwnPropertyNames(ControlDatabase.prototype)
      .flatMap((name) => /^migrateV(\d+)$/.exec(name)?.[1] ?? [])
      .map(Number)
      .sort((left, right) => left - right);
    expect(versions).toEqual(Array.from({ length: CONTROL_SCHEMA_VERSION }, (_, index) => index + 1));
    expect(CONTROL_SCHEMA_VERSION).toBe(versions.at(-1));
  });
  it('migrates v9 browser runtime rows to v10 page health semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-db-v9-'));
    const path = join(dir, 'global.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key,value) VALUES('schema_version','9');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, status TEXT NOT NULL, isolation_tier TEXT NOT NULL, min_slots INTEGER NOT NULL, max_slots INTEGER NOT NULL, weight INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE agent_slots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role TEXT NOT NULL, status TEXT NOT NULL, desired_state TEXT NOT NULL DEFAULT 'active', browser_state TEXT NOT NULL DEFAULT 'absent', conversation_key TEXT, browser_profile_id TEXT, browser_tab_id INTEGER, browser_error TEXT, browser_observed_at INTEGER, lease_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE browser_runtime (profile_id TEXT PRIMARY KEY,
        auth_status TEXT NOT NULL CHECK(auth_status IN ('unknown','authenticated','authentication-required')),
        open_tabs INTEGER NOT NULL CHECK(open_tabs >= 0), extension_version TEXT NOT NULL, observed_at INTEGER NOT NULL) STRICT;
      INSERT INTO browser_runtime VALUES('gam-default','authenticated',2,'0.4.1',100);`);
    legacy.close();
    const database = new ControlDatabase(path);
    const row = database.db.prepare('SELECT * FROM browser_runtime WHERE profile_id=?').get('gam-default') as Record<string, unknown>;
    const version = database.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(row.page_health).toBe('unknown');
    expect(Number(version.value)).toBe(CONTROL_SCHEMA_VERSION);
    database.close(); rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('migrates v12 AgentSlots into v13 conversation lineage without losing the active conversation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-db-v12-'));
    const path = join(dir, 'global.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key,value) VALUES('schema_version','12');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, status TEXT NOT NULL, isolation_tier TEXT NOT NULL, min_slots INTEGER NOT NULL, max_slots INTEGER NOT NULL, weight INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE agent_slots (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role TEXT NOT NULL, status TEXT NOT NULL, desired_state TEXT NOT NULL DEFAULT 'active', browser_state TEXT NOT NULL DEFAULT 'absent', conversation_key TEXT, browser_profile_id TEXT, browser_tab_id INTEGER, browser_error TEXT, browser_observed_at INTEGER, lease_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, browser_lease_id TEXT, browser_lease_epoch INTEGER, browser_content_epoch TEXT, browser_observation_revision INTEGER, browser_page_status TEXT, browser_runtime_observed_at INTEGER, browser_quarantined INTEGER NOT NULL DEFAULT 0, browser_quarantine_reason TEXT) STRICT;
      INSERT INTO projects VALUES('p','Legacy','E:/legacy','active','c0-host',0,1,1,1,1);
      INSERT INTO agent_slots(id,project_id,role,status,desired_state,browser_state,conversation_key,lease_epoch,created_at,updated_at,browser_quarantined) VALUES('slot-1','p','ROLE01','assigned','active','absent','conversation:legacy',4,2,20,0);`);
    legacy.close();

    const database = new ControlDatabase(path);
    const slot = database.db.prepare('SELECT conversation_key,conversation_generation,rollover_state,active_rollover_id FROM agent_slots WHERE id=?').get('slot-1') as Record<string, unknown>;
    const lineage = database.db.prepare('SELECT * FROM agent_conversations WHERE slot_id=?').all('slot-1') as Record<string, unknown>[];
    const version = database.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(slot).toMatchObject({ conversation_key: 'conversation:legacy', conversation_generation: 1, rollover_state: 'idle', active_rollover_id: null });
    expect(lineage).toHaveLength(1);
    expect(lineage[0]).toMatchObject({ id: 'legacy:slot-1', generation: 1, conversation_key: 'conversation:legacy', status: 'active' });
    expect(Number(version.value)).toBe(CONTROL_SCHEMA_VERSION);
    database.close(); rmSync(dir, { recursive: true, force: true });
  });
  it('migrates v14 databases to durable self-hosting promotion authority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gam-db-v14-'));
    const path = join(dir, 'global.db');
    const initial = new ControlDatabase(path);
    initial.db.exec("DROP TABLE self_hosting_promotions; UPDATE schema_meta SET value='14' WHERE key='schema_version';");
    initial.close();

    const database = new ControlDatabase(path);
    const table = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='self_hosting_promotions'").get() as { name?: string } | undefined;
    const version = database.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(table?.name).toBe('self_hosting_promotions');
    expect(Number(version.value)).toBe(CONTROL_SCHEMA_VERSION);
    database.close(); rmSync(dir, { recursive: true, force: true });
  });
});
