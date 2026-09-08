import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { ControlDatabase } from './database';
import { EvidenceAuthority } from './evidenceAuthority';
import { ChangeRequestAuthority } from './changeRequestAuthority';
import { RequestAuthority } from './requestAuthority';
import { WorkAuthority } from './workAuthority';
import { BrowserAuthority } from './browserAuthority';
import { ConversationAuthority } from './conversationAuthority';
import { WorkspaceAuthority } from './workspaceAuthority';
import { PromotionAuthority } from './promotionAuthority';
import { OrganizationAuthority } from './organizationAuthority';
import { WorkIngressAuthority } from './workIngressAuthority';
import { AgentContinuityAuthority } from './agentContinuityAuthority';
import { FindingAuthority } from './findingAuthority';
import { ReviewPoolAuthority } from './reviewPoolAuthority';
import { OrganizationExecutionBridge } from './organizationExecutionBridge';
import { OrganizationRuntimeAcquisitionAuthority } from './organizationRuntimeAcquisitionAuthority';
import { AutonomousIntakeAuthority } from './autonomousIntakeAuthority';
import { OrganizationWorkflowCoordinator } from './organizationWorkflowCoordinator';
import { parseJsonRecord, parseJsonStringArray } from './persistenceCodec';
import { planElasticFleet, type ElasticFleetDecision } from './elasticFleet';
import { projectRootIdentity } from './projectIdentity';
import type {
  AcquireLeaseInput,
  AgentSlot,
  CapabilityGrant,
  ControlEvent,
  CreateProjectInput,
  IssueCapabilityInput,
  IssuedCapability,
  ProjectCell,
  ProjectStatus,
  ResourceKind,
  ResourceLease,
  ResourceRecord,
  BrowserRuntimeStatus,
  ReportBrowserRuntimeInput,
  AgentDesiredState,
  AgentBrowserState,
  ReportAgentBrowserInput,
  ReportAgentRuntimeInput,
  VerifiedTaskCompletion,
  TaskWorkspace,
} from './contracts';

type Row = Record<string, string | number | null>;

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}


function canonicalConversationKey(value: string): string {
  const key = nonEmpty(value, 'Conversation key');
  if (!key.startsWith('conversation:')) throw new Error('Only durable ChatGPT conversation identities may bind an agent slot');
  const id = key.slice('conversation:'.length);
  if (!id || id === 'new' || /^WEB:/i.test(id)) throw new Error('Conversation key must be a canonical durable ChatGPT identity');
  return key;
}

function positiveInt(value: number, label: string, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${label} is invalid`);
  return value;
}

function parseJson<T>(value: string): T {
  return parseJsonRecord(value, 'Persisted control record') as T;
}
function projectFrom(row: Row): ProjectCell {
  return {
    id: String(row.id),
    name: String(row.name),
    rootPath: String(row.root_path),
    status: String(row.status) as ProjectCell['status'],
    isolationTier: String(row.isolation_tier) as ProjectCell['isolationTier'],
    minSlots: Number(row.min_slots),
    maxSlots: Number(row.max_slots),
    weight: Number(row.weight),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function agentFrom(row: Row): AgentSlot {
  const value: AgentSlot = {
    id: String(row.id),
    projectId: String(row.project_id),
    role: String(row.role),
    status: String(row.status) as AgentSlot['status'],
    desiredState: String(row.desired_state) as AgentSlot['desiredState'],
    browserState: String(row.browser_state) as AgentSlot['browserState'],
    conversationGeneration: Number(row.conversation_generation ?? 0),
    rolloverState: String(row.rollover_state ?? 'idle') as AgentSlot['rolloverState'],
    browserQuarantined: Number(row.browser_quarantined ?? 0) === 1,
    leaseEpoch: Number(row.lease_epoch),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.conversation_key !== null) value.conversationKey = String(row.conversation_key);
  if (row.active_rollover_id !== null && row.active_rollover_id !== undefined) value.activeRolloverId = String(row.active_rollover_id);
  if (row.browser_profile_id !== null) value.browserProfileId = String(row.browser_profile_id);
  if (row.browser_tab_id !== null) value.browserTabId = Number(row.browser_tab_id);
  if (row.browser_error !== null) value.browserError = String(row.browser_error);
  if (row.browser_observed_at !== null) value.browserObservedAt = Number(row.browser_observed_at);
  if (row.browser_lease_id !== null && row.browser_lease_id !== undefined) value.browserLeaseId = String(row.browser_lease_id);
  if (row.browser_lease_epoch !== null && row.browser_lease_epoch !== undefined) value.browserLeaseEpoch = Number(row.browser_lease_epoch);
  if (row.browser_content_epoch !== null && row.browser_content_epoch !== undefined) value.browserContentEpoch = String(row.browser_content_epoch);
  if (row.browser_observation_revision !== null && row.browser_observation_revision !== undefined) value.browserObservationRevision = Number(row.browser_observation_revision);
  if (row.browser_page_status !== null && row.browser_page_status !== undefined) value.browserPageStatus = String(row.browser_page_status) as NonNullable<AgentSlot['browserPageStatus']>;
  if (row.browser_runtime_observed_at !== null && row.browser_runtime_observed_at !== undefined) value.browserRuntimeObservedAt = Number(row.browser_runtime_observed_at);
  if (row.browser_quarantine_reason !== null && row.browser_quarantine_reason !== undefined) value.browserQuarantineReason = String(row.browser_quarantine_reason);
  return value;
}

function resourceFrom(row: Row): ResourceRecord {
  const value: ResourceRecord = {
    id: String(row.id),
    kind: String(row.kind) as ResourceKind,
    label: String(row.label),
    metadata: parseJson<Record<string, unknown>>(String(row.metadata_json)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.project_id !== null) value.projectId = String(row.project_id);
  if (row.parent_id !== null) value.parentId = String(row.parent_id);
  return value;
}
function leaseFrom(row: Row): ResourceLease {
  const value: ResourceLease = {
    id: String(row.id),
    resourceId: String(row.resource_id),
    projectId: String(row.project_id),
    holderId: String(row.holder_id),
    mode: String(row.mode) as ResourceLease['mode'],
    epoch: Number(row.epoch),
    status: String(row.status) as ResourceLease['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.task_id !== null) value.taskId = String(row.task_id);
  if (row.expires_at !== null) value.expiresAt = Number(row.expires_at);
  return value;
}

function capabilityFrom(row: Row): CapabilityGrant {
  const value: CapabilityGrant = {
    id: String(row.id),
    subject: String(row.subject),
    projectId: String(row.project_id),
    scopes: parseJsonStringArray(String(row.scopes_json), 'capability scopes'),
    resourceIds: parseJsonStringArray(String(row.resource_ids_json), 'capability resource ids'),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
  if (row.agent_slot_id !== null) value.agentSlotId = String(row.agent_slot_id);
  if (row.task_id !== null) value.taskId = String(row.task_id);
  if (row.lease_epoch !== null) value.leaseEpoch = Number(row.lease_epoch);
  if (row.revoked_at !== null) value.revokedAt = Number(row.revoked_at);
  return value;
}

const PROJECT_TRANSITIONS: Record<ProjectStatus, ReadonlySet<ProjectStatus>> = {
  active: new Set(['draining', 'paused', 'archived']),
  draining: new Set(['active', 'paused', 'archived']),
  paused: new Set(['active', 'archived']),
  archived: new Set(),
};
export class ControlPlane {
  readonly evidence: EvidenceAuthority;
  readonly changes: ChangeRequestAuthority;
  readonly requests: RequestAuthority;
  readonly work: WorkAuthority;
  readonly browser: BrowserAuthority;
  readonly conversations: ConversationAuthority;
  readonly workspaces: WorkspaceAuthority;
  readonly promotions: PromotionAuthority;
  readonly organization: OrganizationAuthority;
  readonly ingress: WorkIngressAuthority;
  readonly agentContinuity: AgentContinuityAuthority;
  readonly findings: FindingAuthority;
  readonly reviewPool: ReviewPoolAuthority;
  readonly organizationExecution: OrganizationExecutionBridge;
  readonly organizationRuntime: OrganizationRuntimeAcquisitionAuthority;
  readonly autonomousIntake: AutonomousIntakeAuthority;
  readonly organizationWorkflow: OrganizationWorkflowCoordinator;
  constructor(readonly database: ControlDatabase, gitPath = 'git') {
    this.evidence = new EvidenceAuthority(database, gitPath);
    this.changes = new ChangeRequestAuthority(database, gitPath);
    this.requests = new RequestAuthority(database);
    this.work = new WorkAuthority(database);
    this.browser = new BrowserAuthority(database);
    this.conversations = new ConversationAuthority(database);
    this.workspaces = new WorkspaceAuthority(database, gitPath);
    this.promotions = new PromotionAuthority(database, gitPath);
    this.organization = new OrganizationAuthority(database);
    this.ingress = new WorkIngressAuthority(database);
    this.agentContinuity = new AgentContinuityAuthority(database);
    this.findings = new FindingAuthority(database);
    this.reviewPool = new ReviewPoolAuthority(database);
    this.organizationExecution = new OrganizationExecutionBridge(database, this.organization, this.work);
    this.organizationRuntime = new OrganizationRuntimeAcquisitionAuthority(database, this.organization, (projectId, role, now) => this.createAgentSlot(projectId, role, now));
    this.autonomousIntake = new AutonomousIntakeAuthority(this);
    this.organizationWorkflow = new OrganizationWorkflowCoordinator(database, this.changes, this.reviewPool, this.organization, this.organizationRuntime, this.organizationExecution, this.promotions, gitPath);
  }

  provisionTaskWorkspace(projectId: string, slotId: string, taskId: string, now = Date.now()) {
    const project = this.requireProject(projectId);
    if (project.status !== 'active') throw new Error('Task workspace requires an active project');
    const slot = this.getAgentSlot(slotId);
    if (slot.projectId !== project.id || slot.desiredState !== 'active' || slot.status === 'retired') throw new Error('Task workspace AgentSlot is not active in this project');
    const task = this.work.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} does not exist in Kernel work state`);
    if (task.kind !== 'work' || task.completionPolicy !== 'verified-claim') throw new Error('Automatic workspaces require a verified-claim work task');
    if (String(task.targetRole ?? '') !== slot.role) throw new Error('Task target role does not match AgentSlot role');
    if (String(task.project ?? '') !== project.name) throw new Error('Task project does not match ProjectCell name');
    const existing = this.workspaces.find(project.id, taskId);
    if (existing) return existing;
    const materialized = this.workspaces.materialize({ projectId: project.id, projectRoot: project.rootPath, slotId: slot.id, role: slot.role, taskId });
    const resourceId = `task-workspace:${project.id}:${taskId}`;
    let resource: ResourceRecord | undefined;
    let lease: ResourceLease | undefined;
    let capability: { id: string; token: string } | undefined;
    let workspace: TaskWorkspace | undefined;
    try {
      try { resource = this.requireResource(resourceId); }
      catch { resource = this.declareResource({ id: resourceId, projectId: project.id, kind: 'workspace', label: `${slot.role}:${taskId}`, metadata: { path: materialized.path, branch: materialized.branch, baseSha: materialized.baseSha, taskId, slotId } }, now); }
      const active = this.listLeases(resource.id).find((item) => item.status === 'active');
      if (active) {
        if (active.holderId !== slot.id || active.taskId !== taskId || active.mode !== 'exclusive') throw new Error('Task workspace resource already has an incompatible active lease');
        lease = active;
      } else lease = this.acquireLease({ resourceId: resource.id, projectId: project.id, holderId: slot.id, taskId, mode: 'exclusive' }, now);
      capability = this.issueCapability({ subject: slot.id, projectId: project.id, agentSlotId: slot.id, taskId, leaseEpoch: lease.epoch, scopes: ['claim:submit','artifact:register','claim:read','claim:verify','org-work:create','org-work:status','review:read','review:claim','review:decide'], resourceIds: [resource.id], ttlMs: 7 * 24 * 60 * 60 * 1000 }, now);
      workspace = this.workspaces.record({ ...materialized, projectId: project.id, taskId, slotId: slot.id, resourceId: resource.id, leaseId: lease.id, leaseEpoch: lease.epoch, capabilityId: capability.id, capabilityToken: capability.token }, now);
      this.event(project.id, 'TASK_WORKSPACE_PROVISIONED', workspace.id, { taskId, slotId: slot.id, branch: workspace.branch, path: workspace.path, resourceId: resource.id, leaseId: lease.id }, now);
      return workspace!;
    } catch (error) {
      if (workspace && capability) { try { this.workspaces.removeCapabilityToken(workspace.id); } catch { /* preserve primary error */ } }
      if (capability) { try { this.revokeCapability(capability.id, now); } catch { /* preserve primary error */ } }
      if (lease && lease.status === 'active') { try { this.releaseLease(lease.id, lease.epoch, now); } catch { /* preserve primary error */ } }
      if (!existing) { try { this.workspaces.abortMaterialized(materialized); } catch { /* preserve primary error */ } }
      try { this.event(project.id, 'TASK_WORKSPACE_PROVISION_FAILED', taskId, { taskId, slotId: slot.id, error: error instanceof Error ? error.message : String(error) }, now); } catch { /* preserve primary error */ }
      throw error;
    }
  }

  releaseTaskWorkspace(workspaceId: string, now = Date.now()) {
    const workspace = this.workspaces.get(workspaceId);
    const released = workspace.status === 'released' ? workspace : this.workspaces.release(workspaceId, now);
    const lease = this.getLease(workspace.leaseId);
    if (lease.status === 'active') this.releaseLease(lease.id, lease.epoch, now);
    this.revokeCapability(workspace.capabilityId, now);
    this.workspaces.removeCapabilityToken(workspace.id);
    this.event(workspace.projectId, 'TASK_WORKSPACE_RELEASED', workspace.id, { taskId: workspace.taskId, slotId: workspace.slotId, branch: workspace.branch }, now);
    return released;
  }

  private finalizeVerifiedTaskWorkspace(workspaceId: string, now: number): void {
    const workspace = this.workspaces.get(workspaceId);
    const lease = this.getLease(workspace.leaseId);
    if (lease.status === 'active') this.releaseLease(lease.id, lease.epoch, now);
    this.revokeCapability(workspace.capabilityId, now);
    this.workspaces.removeCapabilityToken(workspace.id);
    if (workspace.status === 'released') return;
    try {
      const finalized = this.workspaces.finalizeVerified(workspace.id, now, { attempts: 1, timeoutMs: 1_000 });
      const type = finalized.cleanup === 'orphan-preserved' ? 'TASK_WORKSPACE_ORPHAN_PRESERVED' : 'TASK_WORKSPACE_RELEASED';
      this.event(workspace.projectId, type, workspace.id, { taskId: workspace.taskId, slotId: workspace.slotId, branch: workspace.branch, cleanup: finalized.cleanup }, now);
    } catch (error) {
      this.event(workspace.projectId, 'TASK_WORKSPACE_RELEASE_DEFERRED', workspace.id, {
        taskId: workspace.taskId, slotId: workspace.slotId, branch: workspace.branch,
        error: error instanceof Error ? error.message : String(error),
      }, now);
    }
  }

  reconcilePersistedOrganizationWorkflows(now = Date.now()): number {
    const rows = this.database.db.prepare(`
      SELECT c.id AS claim_id, v.id AS verification_id
      FROM claims c JOIN verifications v ON v.claim_id=c.id
      WHERE c.status='verified' AND c.task_id LIKE 'org-work-%' AND v.status='passed'
        AND v.id=(SELECT latest.id FROM verifications latest WHERE latest.claim_id=c.id ORDER BY latest.completed_at DESC LIMIT 1)
      ORDER BY c.updated_at,c.id
    `).all() as Array<{ claim_id: string; verification_id: string }>;
    let reconciled = 0;
    for (const row of rows) {
      const claim = this.evidence.getClaim(row.claim_id);
      const verification = this.evidence.getVerification(row.verification_id);
      const workspace = this.workspaces.find(claim.projectId, claim.taskId);
      if (!workspace) continue;
      this.organizationWorkflow.reconcileVerifiedWork(claim, verification, workspace, now);
      reconciled += 1;
    }
    return reconciled;
  }

  verifyClaimAndCompleteTask(claimId: string, now = Date.now()) {
    const claim = this.evidence.getClaim(claimId);
    const verification = this.evidence.verifyClaim(claimId, now);
    if (verification.status === 'passed' && this.work.taskCompletionPolicy(claim.taskId) === 'verified-claim') {
      const workspace = this.workspaces.find(claim.projectId, claim.taskId);
      const task = this.work.getTask(claim.taskId);
      const completion = task?.machineCompletion as VerifiedTaskCompletion | undefined;
      if (completion) {
        if (completion.kind !== 'verified-claim' || completion.claimId !== claim.id || completion.verificationId !== verification.id || completion.commitSha !== claim.commitSha) {
          throw new Error('Verified-claim task already has a different machine completion');
        }
        if (workspace) this.finalizeVerifiedTaskWorkspace(workspace.id, now);
        return verification;
      }
      if (!workspace || workspace.status !== 'active') throw new Error('Verified-claim task has no active durable TaskWorkspace');
      if (!claim.commitSha || workspace.resourceId !== claim.resourceId || workspace.leaseId !== claim.leaseId || workspace.leaseEpoch !== claim.leaseEpoch || workspace.slotId !== claim.subject) {
        throw new Error('Verified claim does not match the task workspace authority');
      }
      this.work.completeVerifiedClaim({ taskId: claim.taskId, claimId: claim.id, verificationId: verification.id, commitSha: claim.commitSha }, verification.completedAt);
      if (claim.taskId.startsWith('org-work-')) {
        this.organizationWorkflow.reconcileVerifiedWork(claim, verification, workspace, now);
      }
      this.finalizeVerifiedTaskWorkspace(workspace.id, now);
    }
    return verification;
  }

  private event(projectId: string | undefined, type: string, subject: string, payload: Record<string, unknown>, now: number): void {
    this.database.db.prepare(`
      INSERT INTO events(project_id, type, subject, payload_json, created_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(projectId ?? null, type, subject, JSON.stringify(payload), now);
  }

  private requireProject(projectId: string): ProjectCell {
    const row = this.database.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
    if (!row) throw new Error(`Project ${projectId} does not exist`);
    return projectFrom(row);
  }

  private projectReuseRank(project: ProjectCell): readonly [number, number, number, number] {
    const counts = this.database.db.prepare(`
      SELECT
        SUM(CASE WHEN conversation_key IS NOT NULL AND status<>'retired' THEN 1 ELSE 0 END) AS conversations,
        SUM(CASE WHEN status<>'retired' THEN 1 ELSE 0 END) AS slots
      FROM agent_slots WHERE project_id=?
    `).get(project.id) as { conversations: number | null; slots: number | null };
    return [Number(counts.conversations ?? 0), Number(counts.slots ?? 0), project.maxSlots, project.updatedAt];
  }

  private selectReusableProject(candidates: readonly ProjectCell[]): ProjectCell | undefined {
    return [...candidates].sort((left, right) => {
      const a = this.projectReuseRank(left); const b = this.projectReuseRank(right);
      for (let index = 0; index < a.length; index += 1) {
        const delta = b[index]! - a[index]!;
        if (delta !== 0) return delta;
      }
      return left.id.localeCompare(right.id);
    })[0];
  }

  createProject(input: CreateProjectInput, now = Date.now()): ProjectCell {
    const name = nonEmpty(input.name, 'Project name');
    const rootPath = nonEmpty(input.rootPath, 'Project root path');
    const rootIdentity = projectRootIdentity(rootPath);
    const minSlots = positiveInt(input.minSlots ?? 0, 'minSlots', true);
    const maxSlots = positiveInt(input.maxSlots ?? Math.max(minSlots, 1), 'maxSlots', true);
    if (maxSlots < minSlots) throw new Error('maxSlots must be >= minSlots');
    const weight = positiveInt(input.weight ?? 1, 'weight');
    return this.database.transaction(() => {
      const candidates = this.listProjects().filter((project) => project.status !== 'archived' && projectRootIdentity(project.rootPath) === rootIdentity);
      const existing = this.selectReusableProject(candidates);
      if (existing) {
        const mergedMaxSlots = Math.max(maxSlots, ...candidates.map((project) => project.maxSlots));
        const mergedMinSlots = Math.min(minSlots, existing.minSlots, mergedMaxSlots);
        this.database.db.prepare(`UPDATE projects SET status='active',min_slots=?,max_slots=?,updated_at=? WHERE id=?`)
          .run(mergedMinSlots, mergedMaxSlots, now, existing.id);
        const reused = this.requireProject(existing.id);
        this.event(reused.id, 'PROJECT_REUSED', reused.id, { requestedName: name, rootPath, rootIdentity, duplicateProjectIds: candidates.filter((project) => project.id !== reused.id).map((project) => project.id), mergedMinSlots, mergedMaxSlots }, now);
        return reused;
      }
      const id = randomUUID();
      this.database.db.prepare(`
        INSERT INTO projects(id, name, root_path, status, isolation_tier, min_slots, max_slots, weight, created_at, updated_at)
        VALUES(?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `).run(id, name, rootPath, input.isolationTier ?? 'c1-container', minSlots, maxSlots, weight, now, now);
      this.event(id, 'PROJECT_CREATED', id, { name, rootPath, rootIdentity }, now);
      return this.requireProject(id);
    });
  }

  listProjects(): ProjectCell[] {
    return (this.database.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as Row[]).map(projectFrom);
  }
  setProjectStatus(projectId: string, status: ProjectStatus, now = Date.now()): ProjectCell {
    return this.database.transaction(() => {
      const current = this.requireProject(projectId);
      if (current.status === status) return current;
      if (!PROJECT_TRANSITIONS[current.status].has(status)) {
        throw new Error(`Project ${projectId} cannot transition from ${current.status} to ${status}`);
      }
      this.database.db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(status, now, projectId);
      this.event(projectId, 'PROJECT_STATUS_CHANGED', projectId, { from: current.status, to: status }, now);
      return this.requireProject(projectId);
    });
  }

  createAgentSlot(projectId: string, role: string, now = Date.now()): AgentSlot {
    const normalizedRole = nonEmpty(role, 'Agent role');
    return this.database.transaction(() => {
      const project = this.requireProject(projectId);
      if (project.status !== 'active') throw new Error('Agent slots can only be created in an active project');
      const active = this.database.db.prepare("SELECT COUNT(*) AS count FROM agent_slots WHERE project_id=? AND desired_state='active' AND status<>'retired'").get(projectId) as { count: number };
      if (Number(active.count) >= project.maxSlots) throw new Error(`Project ${projectId} has reached maxSlots ${project.maxSlots}`);
      const sameRole = this.database.db.prepare("SELECT id FROM agent_slots WHERE project_id=? AND role=? AND desired_state='active' AND status<>'retired' LIMIT 1").get(projectId, normalizedRole) as { id?: string } | undefined;
      if (sameRole?.id) throw new Error(`Active agent role ${normalizedRole} already exists; use a distinct worker role`);
      const id = randomUUID();
      this.database.db.prepare(`
        INSERT INTO agent_slots(id, project_id, role, status, desired_state, browser_state, lease_epoch, created_at, updated_at)
        VALUES(?, ?, ?, 'idle', 'active', 'absent', 0, ?, ?)
      `).run(id, projectId, normalizedRole, now, now);
      this.event(projectId, 'AGENT_SLOT_CREATED', id, { role: normalizedRole, desiredState: 'active' }, now);
      return this.getAgentSlot(id);
    });
  }

  getAgentSlot(id: string): AgentSlot {
    const row = this.database.db.prepare('SELECT * FROM agent_slots WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Agent slot ${id} does not exist`);
    return agentFrom(row);
  }

  listAgentSlots(projectId?: string): AgentSlot[] {
    const statement = projectId
      ? this.database.db.prepare('SELECT * FROM agent_slots WHERE project_id = ? ORDER BY created_at, id')
      : this.database.db.prepare('SELECT * FROM agent_slots ORDER BY created_at, id');
    const rows = (projectId ? statement.all(projectId) : statement.all()) as Row[];
    return rows.map(agentFrom);
  }
  bindAgentConversation(slotId: string, conversationKey: string, now = Date.now()): AgentSlot {
    const key = canonicalConversationKey(conversationKey);
    return this.database.transaction(() => {
      const slot = this.getAgentSlot(slotId);
      const project = this.requireProject(slot.projectId);
      if (project.status === 'archived') throw new Error('Cannot bind an agent in an archived project');
      if (slot.desiredState !== 'active') throw new Error('Cannot bind a non-active agent slot');
      if (slot.rolloverState !== 'idle') throw new Error('Cannot bind a conversation while rollover is active');
      const organizationAgent = this.database.db.prepare('SELECT id FROM organization_agents WHERE runtime_slot_id=?').get(slot.id) as { id?: string } | undefined;
      if (organizationAgent?.id) {
        const active = this.agentContinuity.active(organizationAgent.id);
        if (active && active.conversationKey !== key) throw new Error('Conversation conflicts with the persistent Organization Agent identity');
      }
      if (slot.conversationKey && slot.conversationKey !== key) throw new Error('Replacing a durable conversation requires an AgentSlot rollover');
      let generation = slot.conversationGeneration;
      if (!slot.conversationKey) {
        const conflict = this.database.db.prepare('SELECT id,browser_state,desired_state,status FROM agent_slots WHERE project_id=? AND conversation_key=? AND id<>?').get(slot.projectId, key, slotId) as { id?: string; browser_state?: string; desired_state?: string; status?: string } | undefined;
        if (conflict?.id) {
          const organizationConversation = organizationAgent?.id ? this.agentContinuity.active(organizationAgent.id) : undefined;
          const oldOrganizationBinding = this.database.db.prepare('SELECT id FROM organization_agents WHERE runtime_slot_id=?').get(conflict.id) as { id?: string } | undefined;
          if (!organizationConversation || organizationConversation.conversationKey !== key || oldOrganizationBinding?.id) {
            throw new Error(`Conversation ${key} is already bound inside project ${slot.projectId}`);
          }
          if (conflict.browser_state !== 'absent') throw new Error('Persistent conversation cannot move while its previous runtime browser is still present');
          this.database.db.prepare("UPDATE agent_conversations SET slot_id=? WHERE project_id=? AND conversation_key=? AND status='active'").run(slot.id, slot.projectId, key);
          this.database.db.prepare("UPDATE agent_slots SET conversation_key=NULL,status=CASE WHEN desired_state='active' THEN 'idle' ELSE status END,lease_epoch=lease_epoch+1,updated_at=? WHERE id=?").run(now, conflict.id);
          this.event(slot.projectId, 'AGENT_CONVERSATION_RUNTIME_MOVED', organizationConversation.agentId, { conversationKey: key, fromSlotId: conflict.id, toSlotId: slot.id }, now);
        }
        generation = this.conversations.recordCanonical(slot, key, now);
        const nextEpoch = slot.leaseEpoch + 1;
        this.database.db.prepare("UPDATE agent_slots SET conversation_key=?,conversation_generation=?,status='assigned',lease_epoch=?,updated_at=? WHERE id=?")
          .run(key, generation, nextEpoch, now, slotId);
        this.event(slot.projectId, 'AGENT_CONVERSATION_BOUND', slotId, { conversationKey: key, generation, epoch: nextEpoch }, now);
      }
      if (organizationAgent?.id) {
        this.agentContinuity.bind({ agentId: organizationAgent.id, conversationKey: key, runtimeSlotId: slot.id, generationHint: generation }, now);
      }
      return this.getAgentSlot(slotId);
    });
  }
  requestAgentConversationRollover(slotId: string, reason: string, handoffText: string, state: Record<string, unknown>, now = Date.now()) {
    const slot = this.getAgentSlot(slotId); const project = this.requireProject(slot.projectId);
    if (project.status !== 'active' || slot.desiredState !== 'active') throw new Error('Conversation rollover requires an active project and AgentSlot');
    return this.conversations.request(slot, reason, handoffText, state, now);
  }

  beginAgentConversationRollover(slotId: string, rolloverId: string, now = Date.now()) {
    const slot = this.getAgentSlot(slotId);
    if (slot.desiredState !== 'active') throw new Error('Conversation rollover requires an active AgentSlot');
    if (slot.browserPageStatus === 'generating') throw new Error('Cannot roll over a generating ChatGPT page');
    return this.conversations.begin(slot, rolloverId, now);
  }

  markAgentRolloverBootstrap(slotId: string, rolloverId: string, attemptId: string, now = Date.now()) {
    return this.conversations.markBootstrap(this.getAgentSlot(slotId), rolloverId, attemptId, now);
  }

  completeAgentConversationRollover(slotId: string, attemptId: string, now = Date.now()) {
    const slot = this.getAgentSlot(slotId);
    const completed = this.conversations.complete(slot, attemptId, now);
    const organizationAgent = this.database.db.prepare('SELECT id FROM organization_agents WHERE runtime_slot_id=?').get(slot.id) as { id?: string } | undefined;
    if (organizationAgent?.id && completed.toConversationKey) {
      const active = this.agentContinuity.active(organizationAgent.id);
      if (active?.conversationKey === completed.fromConversationKey) {
        this.agentContinuity.rollover({
          agentId: organizationAgent.id,
          fromConversationKey: completed.fromConversationKey,
          toConversationKey: completed.toConversationKey,
          runtimeSlotId: slot.id,
          reason: completed.reason,
        }, now);
      }
    }
    return completed;
  }

  failAgentConversationRollover(slotId: string, error: string, now = Date.now()) {
    return this.conversations.fail(this.getAgentSlot(slotId), error, now);
  }

  private fenceAgentAuthority(slotId: string, projectId: string, now: number): void {
    this.database.db.prepare('UPDATE capabilities SET revoked_at=? WHERE project_id=? AND (agent_slot_id=? OR (agent_slot_id IS NULL AND subject=?)) AND revoked_at IS NULL').run(now, projectId, slotId, slotId);
    this.database.db.prepare("UPDATE leases SET status='released',updated_at=? WHERE project_id=? AND holder_id=? AND status='active'").run(now, projectId, slotId);
  }

  suspendAgentSlot(slotId: string, now = Date.now()): AgentSlot {
    return this.database.transaction(() => {
      const slot = this.getAgentSlot(slotId);
      if (slot.status === 'retired' || slot.desiredState === 'retired') throw new Error('Retired agent slot cannot be suspended');
      if (slot.desiredState === 'suspended') return slot;
      const project = this.requireProject(slot.projectId);
      const active = this.database.db.prepare("SELECT COUNT(*) AS count FROM agent_slots WHERE project_id=? AND desired_state='active' AND status<>'retired'").get(slot.projectId) as { count: number };
      if (project.status === 'active' && Number(active.count) - 1 < project.minSlots) throw new Error(`Suspending this slot would violate minSlots ${project.minSlots}`);
      if (slot.browserState === 'absent') {
        this.fenceAgentAuthority(slot.id, slot.projectId, now);
        this.database.db.prepare("UPDATE agent_slots SET desired_state='suspended',status='suspended',lease_epoch=lease_epoch+1,updated_at=? WHERE id=?").run(now, slotId);
        this.event(slot.projectId, 'AGENT_SLOT_SUSPENDED', slotId, { previousDesiredState: slot.desiredState, finalized: true }, now);
      } else {
        this.database.db.prepare("UPDATE agent_slots SET desired_state='suspended',updated_at=? WHERE id=?").run(now, slotId);
        this.event(slot.projectId, 'AGENT_SLOT_DRAIN_REQUESTED', slotId, { previousDesiredState: slot.desiredState, browserState: slot.browserState }, now);
      }
      return this.getAgentSlot(slotId);
    });
  }

  reconcileElasticFleet(now = Date.now(), idleGraceMs?: number): ElasticFleetDecision[] {
    const work = this.work.snapshot();
    const agents = this.listAgentSlots();
    const activeLeaseRows = this.database.db.prepare("SELECT DISTINCT holder_id FROM leases l JOIN resources r ON r.id=l.resource_id WHERE l.status='active' AND r.kind<>'browser-capacity'").all() as { holder_id: string }[];
    const unsettledRows = this.database.db.prepare("SELECT DISTINCT slot_id FROM browser_operations WHERE slot_id IS NOT NULL AND state<>'settled'").all() as { slot_id: string }[];
    const activeLeaseHolderIds = new Set(activeLeaseRows.map((row) => String(row.holder_id)));
    const unsettledBrowserSlotIds = new Set(unsettledRows.map((row) => String(row.slot_id)));
    const decisions: ElasticFleetDecision[] = [];
    for (const project of this.listProjects()) {
      const planned = planElasticFleet({ project, agents, work, activeLeaseHolderIds, unsettledBrowserSlotIds, now, ...(idleGraceMs === undefined ? {} : { idleGraceMs }) });
      for (const decision of planned) {
        if (decision.kind === 'suspend') {
          this.suspendAgentSlot(decision.slotId, now);
          this.event(project.id, 'ELASTIC_FLEET_SUSPEND_REQUESTED', decision.slotId, { reason: decision.reason }, now);
          decisions.push(decision);
        } else if (decision.kind === 'resume') {
          this.resumeAgentSlot(decision.slotId, now);
          this.event(project.id, 'ELASTIC_FLEET_RESUME_REQUESTED', decision.slotId, { reason: decision.reason }, now);
          decisions.push(decision);
        } else {
          const created = this.createAgentSlot(project.id, decision.role, now);
          const applied = { ...decision, slotId: created.id };
          this.event(project.id, 'ELASTIC_FLEET_AGENT_SPAWNED', created.id, { role: decision.role, affinityKey: decision.affinityKey, reason: decision.reason }, now);
          decisions.push(applied);
        }
      }
    }
    return decisions;
  }

  resumeAgentSlot(slotId: string, now = Date.now()): AgentSlot {
    return this.database.transaction(() => {
      const slot = this.getAgentSlot(slotId);
      if (slot.status === 'retired' || slot.desiredState === 'retired') throw new Error('Retired agent slot cannot be resumed');
      if (slot.desiredState === 'active') return slot;
      const project = this.requireProject(slot.projectId);
      if (project.status !== 'active') throw new Error('Agent slots can only resume in an active project');
      const active = this.database.db.prepare("SELECT COUNT(*) AS count FROM agent_slots WHERE project_id=? AND desired_state='active' AND status<>'retired'").get(slot.projectId) as { count: number };
      if (Number(active.count) >= project.maxSlots) throw new Error(`Project ${slot.projectId} has reached maxSlots ${project.maxSlots}`);
      const status = slot.conversationKey ? 'assigned' : 'idle';
      this.database.db.prepare("UPDATE agent_slots SET desired_state='active',status=?,lease_epoch=lease_epoch+1,updated_at=? WHERE id=?").run(status, now, slotId);
      this.event(slot.projectId, 'AGENT_SLOT_RESUMED', slotId, { conversationKey: slot.conversationKey ?? null }, now);
      return this.getAgentSlot(slotId);
    });
  }

  retireAgentSlot(slotId: string, now = Date.now()): AgentSlot {
    return this.database.transaction(() => {
      const slot = this.getAgentSlot(slotId);
      if (slot.status === 'retired' && slot.desiredState === 'retired') return slot;
      const project = this.requireProject(slot.projectId);
      if (slot.desiredState === 'active' && project.status === 'active') {
        const active = this.database.db.prepare("SELECT COUNT(*) AS count FROM agent_slots WHERE project_id=? AND desired_state='active' AND status<>'retired'").get(slot.projectId) as { count: number };
        if (Number(active.count) - 1 < project.minSlots) throw new Error('Retiring this slot would violate minSlots ' + project.minSlots);
      }
      if (slot.browserState === 'absent') {
        this.fenceAgentAuthority(slot.id, slot.projectId, now);
        this.database.db.prepare("UPDATE agent_slots SET desired_state='retired',status='retired',lease_epoch=lease_epoch+1,updated_at=? WHERE id=?").run(now, slotId);
        this.event(slot.projectId, 'AGENT_SLOT_RETIRED', slotId, { conversationKey: slot.conversationKey ?? null, finalized: true }, now);
      } else {
        this.database.db.prepare("UPDATE agent_slots SET desired_state='retired',updated_at=? WHERE id=?").run(now, slotId);
        this.event(slot.projectId, 'AGENT_SLOT_RETIRE_REQUESTED', slotId, { conversationKey: slot.conversationKey ?? null, browserState: slot.browserState }, now);
      }
      return this.getAgentSlot(slotId);
    });
  }

  reportAgentBrowser(input: ReportAgentBrowserInput, now = input.observedAt ?? Date.now()): AgentSlot {
    const profileId = nonEmpty(input.profileId, 'Browser profile id');
    if (!['absent','opening','open','closing','error'].includes(input.browserState)) throw new Error('Agent browser state is invalid');
    if (input.tabId !== undefined && (!Number.isInteger(input.tabId) || input.tabId <= 0)) throw new Error('Agent browser tabId is invalid');
    if (!Number.isInteger(now) || now <= 0) throw new Error('Agent browser observedAt is invalid');
    return this.database.transaction(() => {
      const slot = this.getAgentSlot(input.slotId);
      const organizationAgent = this.database.db.prepare('SELECT id FROM organization_agents WHERE runtime_slot_id=?').get(slot.id) as { id?: string } | undefined;
      if (organizationAgent?.id) {
        const workspace = this.organization.activeAgentWorkspace(organizationAgent.id);
        if (!workspace || workspace.status !== 'ready') throw new Error('Organization Agent runtime has no ready dedicated workspace');
        if (!workspace.browserProfileId || workspace.browserProfileId !== profileId) {
          throw new Error('Browser profile does not match the Organization Agent workspace');
        }
      }
      if (slot.browserObservedAt !== undefined && now < slot.browserObservedAt) throw new Error('Stale agent browser observation');
      if (['opening','open'].includes(input.browserState) && slot.desiredState !== 'active') throw new Error('Browser cannot open a non-active agent slot');
      let conversationKey = slot.conversationKey;
      let conversationGeneration = slot.conversationGeneration;
      let nextEpoch = slot.leaseEpoch;
      if (input.conversationKey) {
        const key = canonicalConversationKey(input.conversationKey);
        const organizationConversation = organizationAgent?.id ? this.agentContinuity.active(organizationAgent.id) : undefined;
        const activeRollover = this.conversations.activeRollover(slot.id);
        const organizationRolloverAllowed = Boolean(
          organizationConversation && organizationConversation.conversationKey !== key && activeRollover &&
          ['opening','bootstrapping'].includes(activeRollover.status) && activeRollover.fromConversationKey === organizationConversation.conversationKey
        );
        if (organizationConversation && organizationConversation.conversationKey !== key && !organizationRolloverAllowed) {
          throw new Error('Browser conversation conflicts with the persistent Organization Agent conversation');
        }
        if (conversationKey && conversationKey !== key) throw new Error('Browser cannot rebind an agent slot to a different durable conversation');
        const conflict = this.database.db.prepare('SELECT id FROM agent_slots WHERE project_id=? AND conversation_key=? AND id<>?').get(slot.projectId, key, slot.id) as { id?: string } | undefined;
        if (conflict?.id) throw new Error(`Conversation ${key} is already bound inside project ${slot.projectId}`);
        if (!conversationKey) {
          const accepted = this.conversations.acceptCanonical(slot, key, now);
          conversationKey = key; conversationGeneration = accepted.generation; nextEpoch += 1;
        }
        if (organizationAgent?.id) {
          if (!organizationConversation) {
            this.agentContinuity.bind({ agentId: organizationAgent.id, conversationKey: key, runtimeSlotId: slot.id, generationHint: conversationGeneration }, now);
          } else if (organizationConversation.conversationKey === key) {
            this.agentContinuity.attachRuntimeSlot(organizationAgent.id, slot.id, now);
          } else if (organizationRolloverAllowed && activeRollover) {
            // Keep Organization Agent cognition on the verified source generation until bootstrap completion.
          }
        }
      }
      let status = slot.desiredState === 'active' ? (conversationKey ? 'assigned' : 'idle') : slot.status;
      const finalizingStop = input.browserState === 'absent' && slot.desiredState !== 'active' && slot.status !== slot.desiredState;
      const tabId = input.browserState === 'absent' ? null : input.tabId ?? slot.browserTabId ?? null;
      if (['opening','open'].includes(input.browserState) && tabId === null) throw new Error('Opening/open browser state requires tabId');

      let browserLeaseId = slot.browserLeaseId ?? null;
      let browserLeaseEpoch = slot.browserLeaseEpoch ?? null;
      const addressChanged = tabId !== null && slot.browserTabId !== undefined && slot.browserTabId !== tabId;
      if (slot.browserLeaseId && (input.browserState === 'absent' || addressChanged)) {
        this.browser.releaseOccupancy(slot, now); browserLeaseId = null; browserLeaseEpoch = null;
      }
      if (tabId !== null && input.browserState !== 'absent') {
        const occupancy = this.browser.ensureOccupancy(slot, profileId, tabId, now);
        browserLeaseId = occupancy.id; browserLeaseEpoch = occupancy.epoch;
      }
      if (input.browserState === 'absent') this.browser.settleUnfinishedForSlot(slot.id, 'browser-tab-absent', now);
      if (finalizingStop) {
        this.fenceAgentAuthority(slot.id, slot.projectId, now);
        nextEpoch += 1; status = slot.desiredState === 'retired' ? 'retired' : 'suspended';
      }
      const error = input.browserState === 'error' ? nonEmpty(input.error ?? 'Browser runtime reported an error', 'Browser error') : null;
      const clearRuntime = input.browserState === 'absent';
      this.database.db.prepare(`UPDATE agent_slots SET conversation_key=?,conversation_generation=?,status=?,browser_state=?,browser_profile_id=?,browser_tab_id=?,browser_error=?,browser_observed_at=?,
        browser_lease_id=?,browser_lease_epoch=?,browser_content_epoch=?,browser_observation_revision=?,browser_page_status=?,browser_runtime_observed_at=?,browser_quarantined=?,browser_quarantine_reason=?,lease_epoch=?,updated_at=? WHERE id=?`)
        .run(conversationKey ?? null, conversationGeneration, status, input.browserState, profileId, tabId, error, now, browserLeaseId, browserLeaseEpoch,
          clearRuntime ? null : slot.browserContentEpoch ?? null, clearRuntime ? null : slot.browserObservationRevision ?? null, clearRuntime ? null : slot.browserPageStatus ?? null,
          clearRuntime ? null : slot.browserRuntimeObservedAt ?? null, clearRuntime ? 0 : slot.browserQuarantined ? 1 : 0, clearRuntime ? null : slot.browserQuarantineReason ?? null, nextEpoch, now, slot.id);
      const next = this.getAgentSlot(slot.id);
      if (finalizingStop) this.event(slot.projectId, slot.desiredState === 'retired' ? 'AGENT_SLOT_RETIRED' : 'AGENT_SLOT_SUSPENDED', slot.id, { conversationKey: next.conversationKey ?? null, finalized: true }, now);
      if (slot.browserState !== next.browserState || slot.browserTabId !== next.browserTabId || slot.conversationKey !== next.conversationKey || slot.browserLeaseId !== next.browserLeaseId) {
        this.event(slot.projectId, 'AGENT_BROWSER_OBSERVED', slot.id, { browserState: next.browserState, tabId: next.browserTabId ?? null, conversationKey: next.conversationKey ?? null, browserLeaseId: next.browserLeaseId ?? null, browserLeaseEpoch: next.browserLeaseEpoch ?? null }, now);
      }
      return next;
    });
  }

  reportAgentRuntime(input: ReportAgentRuntimeInput): AgentSlot {
    return this.database.transaction(() => {
      const slot = this.getAgentSlot(input.slotId);
      this.browser.reportRuntime(slot, input);
      return this.getAgentSlot(slot.id);
    });
  }

  declareResource(input: {
    id?: string;
    projectId?: string;
    parentId?: string;
    kind: ResourceKind;
    label: string;
    metadata?: Record<string, unknown>;
  }, now = Date.now()): ResourceRecord {
    const id = input.id?.trim() || randomUUID();
    const label = nonEmpty(input.label, 'Resource label');
    return this.database.transaction(() => {
      if (input.projectId) this.requireProject(input.projectId);
      if (input.parentId) this.requireResource(input.parentId);
      this.database.db.prepare(`
        INSERT INTO resources(id, project_id, parent_id, kind, label, metadata_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.projectId ?? null, input.parentId ?? null, input.kind, label, JSON.stringify(input.metadata ?? {}), now, now);
      this.event(input.projectId, 'RESOURCE_DECLARED', id, { kind: input.kind, label }, now);
      return this.requireResource(id);
    });
  }
  requireResource(id: string): ResourceRecord {
    const row = this.database.db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Resource ${id} does not exist`);
    return resourceFrom(row);
  }

  listResources(projectId?: string): ResourceRecord[] {
    const statement = projectId
      ? this.database.db.prepare('SELECT * FROM resources WHERE project_id = ? OR project_id IS NULL ORDER BY created_at, id')
      : this.database.db.prepare('SELECT * FROM resources ORDER BY created_at, id');
    const rows = (projectId ? statement.all(projectId) : statement.all()) as Row[];
    return rows.map(resourceFrom);
  }

  private expireResourceLeases(resourceId: string, now: number): void {
    this.database.db.prepare(`
      UPDATE leases SET status = 'expired', updated_at = ?
      WHERE resource_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, resourceId, now);
  }

  private activeLeaseRows(resourceId: string): Row[] {
    return this.database.db.prepare(`
      SELECT * FROM leases WHERE resource_id = ? AND status = 'active' ORDER BY created_at, id
    `).all(resourceId) as Row[];
  }
  acquireLease(input: AcquireLeaseInput, now = Date.now()): ResourceLease {
    return this.database.transaction(() => {
      const resource = this.requireResource(input.resourceId);
      const project = this.requireProject(input.projectId);
      if (project.status !== 'active') throw new Error(`Project ${project.id} is not active`);
      if (resource.projectId && resource.projectId !== project.id) {
        throw new Error(`Resource ${resource.id} belongs to project ${resource.projectId}`);
      }
      const holderId = nonEmpty(input.holderId, 'Lease holder');
      const holderSlot = this.database.db.prepare('SELECT id, desired_state, status FROM agent_slots WHERE id = ? AND project_id = ?').get(holderId, project.id) as { id?: string; desired_state?: string; status?: string } | undefined;
      if (holderSlot?.id && (holderSlot.desired_state !== 'active' || holderSlot.status === 'retired')) {
        throw new Error(`Agent slot ${holderId} is not active and cannot acquire a lease`);
      }
      if (input.ttlMs !== undefined && (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0)) {
        throw new Error('Lease ttlMs must be a positive integer');
      }
      this.expireResourceLeases(resource.id, now);
      const active = this.activeLeaseRows(resource.id).map(leaseFrom);
      const conflict = input.mode === 'exclusive'
        ? active.length > 0
        : active.some((lease) => lease.mode === 'exclusive');
      if (conflict) throw new Error(`Resource ${resource.id} is already leased incompatibly`);
      const epochRow = this.database.db.prepare('SELECT lease_epoch FROM resources WHERE id = ?').get(resource.id) as { lease_epoch: number };
      const epoch = Number(epochRow.lease_epoch) + 1;
      this.database.db.prepare('UPDATE resources SET lease_epoch = ?, updated_at = ? WHERE id = ?').run(epoch, now, resource.id);
      const id = randomUUID();
      const expiresAt = input.ttlMs === undefined ? null : now + input.ttlMs;
      this.database.db.prepare(`
        INSERT INTO leases(id, resource_id, project_id, holder_id, task_id, mode, epoch, status, expires_at, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(id, resource.id, project.id, input.holderId.trim(), input.taskId?.trim() || null, input.mode, epoch, expiresAt, now, now);
      this.event(project.id, 'LEASE_ACQUIRED', id, { resourceId: resource.id, holderId: input.holderId, mode: input.mode, epoch }, now);
      return this.getLease(id);
    });
  }
  getLease(id: string): ResourceLease {
    const row = this.database.db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`Lease ${id} does not exist`);
    return leaseFrom(row);
  }

  listLeases(resourceId?: string): ResourceLease[] {
    const statement = resourceId
      ? this.database.db.prepare('SELECT * FROM leases WHERE resource_id = ? ORDER BY created_at, id')
      : this.database.db.prepare('SELECT * FROM leases ORDER BY created_at, id');
    const rows = (resourceId ? statement.all(resourceId) : statement.all()) as Row[];
    return rows.map(leaseFrom);
  }

  renewLease(id: string, epoch: number, ttlMs: number, now = Date.now()): ResourceLease {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('Lease ttlMs must be a positive integer');
    return this.database.transaction(() => {
      const lease = this.getLease(id);
      this.expireResourceLeases(lease.resourceId, now);
      const current = this.getLease(id);
      if (current.status !== 'active') throw new Error(`Lease ${id} is not active`);
      if (current.epoch !== epoch) throw new Error(`Lease ${id} epoch is stale`);
      const project = this.requireProject(current.projectId);
      if (!['active', 'draining'].includes(project.status)) throw new Error(`Project ${project.id} cannot renew leases while ${project.status}`);
      const expiresAt = now + ttlMs;
      this.database.db.prepare('UPDATE leases SET expires_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, now, id);
      this.event(project.id, 'LEASE_RENEWED', id, { epoch, expiresAt }, now);
      return this.getLease(id);
    });
  }
  releaseLease(id: string, epoch: number, now = Date.now()): ResourceLease {
    return this.database.transaction(() => {
      const lease = this.getLease(id);
      this.expireResourceLeases(lease.resourceId, now);
      const current = this.getLease(id);
      if (current.status !== 'active') throw new Error(`Lease ${id} is not active`);
      if (current.epoch !== epoch) throw new Error(`Lease ${id} epoch is stale`);
      this.database.db.prepare(`UPDATE leases SET status = 'released', updated_at = ? WHERE id = ?`).run(now, id);
      this.event(current.projectId, 'LEASE_RELEASED', id, { resourceId: current.resourceId, epoch }, now);
      return this.getLease(id);
    });
  }

  issueCapability(input: IssueCapabilityInput, now = Date.now()): IssuedCapability {
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error('Capability ttlMs must be a positive integer');
    const subject = nonEmpty(input.subject, 'Capability subject');
    const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
    if (scopes.length === 0) throw new Error('Capability scopes are required');
    const resourceIds = [...new Set(input.resourceIds ?? [])].sort();
    return this.database.transaction(() => {
      this.requireProject(input.projectId);
      if (input.agentSlotId) {
        const slot = this.getAgentSlot(input.agentSlotId);
        if (slot.projectId !== input.projectId) throw new Error('Capability agent slot belongs to another project');
        if (slot.desiredState !== 'active' || slot.status === 'retired') throw new Error('Capability agent slot is not active');
        if (subject !== slot.id) throw new Error('Agent-bound capability subject must equal agentSlotId');
      }
      for (const resourceId of resourceIds) {
        const resource = this.requireResource(resourceId);
        if (resource.projectId && resource.projectId !== input.projectId) {
          throw new Error(`Capability cannot include resource ${resourceId} from another project`);
        }
      }
      const taskWrite = scopes.some((scope) => ['claim:submit','artifact:register','change:open','change:update'].includes(scope));
      if (taskWrite) {
        const taskId = input.taskId?.trim();
        if (!taskId) throw new Error('Task-write capability requires taskId');
        if (!Number.isInteger(input.leaseEpoch) || input.leaseEpoch! <= 0) throw new Error('Task-write capability requires leaseEpoch');
        if (resourceIds.length !== 1) throw new Error('Task-write capability requires exactly one resource');
        const lease = this.database.db.prepare(`
          SELECT id FROM leases WHERE resource_id=? AND project_id=? AND holder_id=? AND task_id=? AND epoch=?
            AND status='active' AND (expires_at IS NULL OR expires_at > ?)
        `).get(resourceIds[0]!, input.projectId, subject, taskId, input.leaseEpoch!, now) as { id?: string } | undefined;
        if (!lease?.id) throw new Error('Task-write capability does not match an active lease');
      }
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = now + input.ttlMs;
      this.database.db.prepare(`
        INSERT INTO capabilities(id, token_hash, subject, project_id, agent_slot_id, task_id, lease_epoch, scopes_json, resource_ids_json, expires_at, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, tokenHash, subject, input.projectId, input.agentSlotId ?? null, input.taskId?.trim() || null, input.leaseEpoch ?? null, JSON.stringify(scopes), JSON.stringify(resourceIds), expiresAt, now);
      this.event(input.projectId, 'CAPABILITY_ISSUED', id, { subject, agentSlotId: input.agentSlotId ?? null, scopes, resourceIds, expiresAt }, now);
      return { ...this.getCapabilityByHash(tokenHash), token };
    });
  }
  private getCapabilityByHash(tokenHash: string): CapabilityGrant {
    const row = this.database.db.prepare('SELECT * FROM capabilities WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    if (!row) throw new Error('Capability token is invalid');
    return capabilityFrom(row);
  }

  verifyCapability(token: string, requiredScope: string, options: {
    projectId?: string;
    resourceId?: string;
    leaseEpoch?: number;
    now?: number;
  } = {}): CapabilityGrant {
    const now = options.now ?? Date.now();
    const tokenHash = createHash('sha256').update(nonEmpty(token, 'Capability token')).digest('hex');
    const capability = this.getCapabilityByHash(tokenHash);
    if (capability.revokedAt !== undefined) throw new Error('Capability token is revoked');
    if (capability.expiresAt <= now) throw new Error('Capability token is expired');
    if (!capability.scopes.includes(requiredScope)) throw new Error(`Capability does not grant scope ${requiredScope}`);
    if (options.projectId && capability.projectId !== options.projectId) throw new Error('Capability project does not match');
    if (options.resourceId && !capability.resourceIds.includes(options.resourceId)) throw new Error('Capability does not grant this resource');
    if (options.leaseEpoch !== undefined && capability.leaseEpoch !== options.leaseEpoch) throw new Error('Capability lease epoch is stale');
    return capability;
  }

  revokeCapability(id: string, now = Date.now()): CapabilityGrant {
    return this.database.transaction(() => {
      const row = this.database.db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id) as Row | undefined;
      if (!row) throw new Error(`Capability ${id} does not exist`);
      const current = capabilityFrom(row);
      if (current.revokedAt === undefined) {
        this.database.db.prepare('UPDATE capabilities SET revoked_at = ? WHERE id = ?').run(now, id);
        this.event(current.projectId, 'CAPABILITY_REVOKED', id, {}, now);
      }
      const next = this.database.db.prepare('SELECT * FROM capabilities WHERE id = ?').get(id) as Row;
      return capabilityFrom(next);
    });
  }
  reportBrowserRuntime(input: ReportBrowserRuntimeInput, now = input.observedAt ?? Date.now()): BrowserRuntimeStatus {
    const profileId = nonEmpty(input.profileId, 'Browser profile id');
    if (!['unknown', 'authenticated', 'authentication-required'].includes(input.authStatus)) throw new Error('Browser auth status is invalid');
    if (!['unknown','ready','generating','blocked','error','unavailable'].includes(input.pageHealth)) throw new Error('Browser page health is invalid');
    if (!Number.isInteger(input.openTabs) || input.openTabs < 0) throw new Error('Browser openTabs is invalid');
    const extensionVersion = nonEmpty(input.extensionVersion, 'Extension version');
    if (!Number.isInteger(now) || now <= 0) throw new Error('Browser observedAt is invalid');
    const current = this.database.db.prepare('SELECT observed_at FROM browser_runtime WHERE profile_id=?').get(profileId) as { observed_at?: number } | undefined;
    if (current?.observed_at !== undefined && now < Number(current.observed_at)) throw new Error('Stale browser runtime observation');
    this.database.db.prepare(`
      INSERT INTO browser_runtime(profile_id,auth_status,page_health,open_tabs,extension_version,observed_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(profile_id) DO UPDATE SET auth_status=excluded.auth_status,page_health=excluded.page_health,open_tabs=excluded.open_tabs,
        extension_version=excluded.extension_version,observed_at=excluded.observed_at
    `).run(profileId, input.authStatus, input.pageHealth, input.openTabs, extensionVersion, now);
    return { profileId, authStatus: input.authStatus, pageHealth: input.pageHealth, openTabs: input.openTabs, extensionVersion, observedAt: now };
  }

  listBrowserRuntime(): BrowserRuntimeStatus[] {
    const rows = this.database.db.prepare('SELECT * FROM browser_runtime ORDER BY profile_id').all() as Row[];
    return rows.map((row) => ({
      profileId: String(row.profile_id), authStatus: String(row.auth_status) as BrowserRuntimeStatus['authStatus'],
      pageHealth: String(row.page_health) as BrowserRuntimeStatus['pageHealth'],
      openTabs: Number(row.open_tabs), extensionVersion: String(row.extension_version), observedAt: Number(row.observed_at),
    }));
  }
  listEvents(projectId?: string, afterSeq = 0, limit = 200): ControlEvent[] {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error('afterSeq is invalid');
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error('limit is invalid');
    const rows = (projectId
      ? this.database.db.prepare(`SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(projectId, afterSeq, limit)
      : this.database.db.prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?`).all(afterSeq, limit)) as Row[];
    return rows.map((row) => {
      const event: ControlEvent = {
        seq: Number(row.seq),
        type: String(row.type),
        subject: String(row.subject),
        payload: parseJson<Record<string, unknown>>(String(row.payload_json)),
        createdAt: Number(row.created_at),
      };
      if (row.project_id !== null) event.projectId = String(row.project_id);
      return event;
    });
  }
}
