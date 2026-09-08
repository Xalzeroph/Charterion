import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ControlDatabase } from './database';
import type { ChangeRequestAuthority } from './changeRequestAuthority';
import type { ReviewPoolAuthority } from './reviewPoolAuthority';
import type { WorkClaim, VerificationRecord, TaskWorkspace, ChangeRequest } from './contracts';
import type { ReviewRequestRecord, ReviewSlotRecord } from './reviewPoolContracts';
import type { OrganizationAuthority } from './organizationAuthority';
import type { OrganizationRuntimeAcquisitionAuthority } from './organizationRuntimeAcquisitionAuthority';
import type { OrganizationExecutionBridge } from './organizationExecutionBridge';
import type { OrganizationAgentRecord } from './organizationContracts';
import type { PromotionAuthority } from './promotionAuthority';

export interface OrganizationWorkflowReconciliation {
  organizationId: string;
  workItemId: string;
  changeRequest?: ChangeRequest;
  reviewRequest?: ReviewRequestRecord;
  status: 'review-ready' | 'blocked' | 'not-applicable';
  reason?: string;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(label + ' is required');
  return normalized;
}

export class OrganizationWorkflowCoordinator {
  constructor(
    private readonly database: ControlDatabase,
    private readonly changes: ChangeRequestAuthority,
    private readonly reviewPool: ReviewPoolAuthority,
    private readonly organization: OrganizationAuthority,
    private readonly organizationRuntime: OrganizationRuntimeAcquisitionAuthority,
    private readonly organizationExecution: OrganizationExecutionBridge,
    private readonly promotions: PromotionAuthority,
    private readonly gitPath = 'git',
  ) {}

  private event(projectId: string, type: string, subject: string, payload: Record<string, unknown>, now: number): void {
    this.database.db.prepare('INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(projectId, type, subject, JSON.stringify(payload), now);
  }

  private organizationFor(workItemId: string): { organizationId?: string; projectId?: string; missionId?: string } | undefined {
    return this.database.db.prepare(`
      SELECT m.organization_id AS organizationId,m.project_id AS projectId,m.id AS missionId
      FROM organization_work_items w JOIN missions m ON m.id=w.mission_id WHERE w.id=?
    `).get(workItemId) as { organizationId?: string; projectId?: string; missionId?: string } | undefined;
  }

  private targetBranch(root: string, baseSha: string): string {
    for (const branch of ['main', 'master']) {
      const result = spawnSync(this.gitPath, ['-C', root, 'rev-parse', '--verify', `${branch}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false });
      if (result.status === 0 && result.stdout.trim().toLowerCase() === baseSha.toLowerCase()) return branch;
    }
    throw new Error('No main or master target branch matches the workspace base SHA');
  }

  private reviewerFor(organizationId: string, authorSubject: string, now: number): OrganizationAgentRecord {
    const reusable = this.organization.listAgents(organizationId)
      .filter((agent) => agent.status === 'active' && agent.id !== authorSubject && !agent.runtimeSlotId)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
    if (reusable) return reusable;
    const department = this.organization.listDepartments(organizationId)[0] ?? this.organization.createDepartment({
      organizationId, name: 'Verification & Quality', purpose: 'Independent evidence and change review',
    }, now);
    return this.organization.registerAgent({
      organizationId, displayName: 'Autonomous Review Agent', primaryDepartmentId: department.id,
    }, now);
  }

  private configureReviewer(agent: OrganizationAgentRecord, projectId: string, root: string, now: number): void {
    let workspace = this.organization.activeAgentWorkspace(agent.id);
    if (!workspace) workspace = this.organization.requestAgentWorkspace({ agentId: agent.id }, now);
    if (workspace.status === 'ready') return;
    if (workspace.status !== 'configuring' && workspace.status !== 'error') throw new Error('Reviewer workspace is not configurable');
    this.organization.configureAgentWorkspace({
      workspaceId: workspace.id, rootRef: root, browserProfileId: `charterion-review-${agent.id}`,
      toolProfileRef: `charterion-review-tools-${agent.id}`, allowedRefs: [root], forbiddenRefs: [], securityMode: 'prompt-guarded',
      dangerousActionPolicy: 'approval-required', toolPolicyState: 'unconfigured',
    }, now);
    void projectId;
  }

  private materializeReviewSlot(
    identity: { organizationId: string; projectId: string; missionId: string },
    request: ReviewRequestRecord,
    slot: ReviewSlotRecord,
    authorSubject: string,
    root: string,
    now: number,
  ): void {
    const marker = `Review request ${request.id} slot ${slot.id}`;
    const existingBinding = this.database.db.prepare('SELECT id FROM organization_review_work_items WHERE review_slot_id=?').get(slot.id) as { id?: string } | undefined;
    if (existingBinding?.id) return;
    // Compatibility recovery for review work materialized before the typed binding existed.
    if (this.organization.listWorkItems(identity.missionId).some((item) => item.objective.includes(marker))) return;
    const reviewer = this.reviewerFor(identity.organizationId, authorSubject, now);
    this.organization.addMissionMember(identity.missionId, reviewer.id, 'reviewer', now);
    this.configureReviewer(reviewer, identity.projectId, root, now);
    const runtime = this.organizationRuntime.requestAndAcquire({
      organizationId: identity.organizationId, agentId: reviewer.id, projectId: identity.projectId,
      role: `Review:${slot.dimension}`, idempotencyKey: `review-runtime:${request.id}:${slot.id}`,
    }, now);
    const work = this.organization.createWorkItem({
      missionId: identity.missionId, title: `Review ${slot.dimension}`,
      objective: `${marker}. Inspect the exact Change Request head and record an evidence-backed decision.`,
      ownerAgentId: reviewer.id, completionPolicy: 'structured-result',
    }, now);
    this.organization.setWorkStatus(work.id, 'ready', now);
    this.organizationExecution.materialize(work.id, now);
    const bindingId = randomUUID();
    this.database.db.prepare(`INSERT INTO organization_review_work_items(
      id,organization_id,project_id,mission_id,review_request_id,review_slot_id,work_item_id,
      reviewer_agent_id,runtime_acquisition_id,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'materialized',?,?)`).run(
      bindingId, identity.organizationId, identity.projectId, identity.missionId, request.id, slot.id,
      work.id, reviewer.id, runtime.id, now, now,
    );
    this.event(identity.projectId, 'REVIEW_WORK_MATERIALIZED', work.id, {
      bindingId, reviewRequestId: request.id, reviewSlotId: slot.id, reviewerAgentId: reviewer.id, runtimeAcquisitionId: runtime.id,
    }, now);
  }

  private materializeReviewWorks(
    identity: { organizationId: string; projectId: string; missionId: string },
    request: ReviewRequestRecord,
    authorSubject: string,
    root: string,
    now: number,
  ): void {
    for (const slot of this.reviewPool.listSlots(request.id)) {
      if (slot.state === 'open' && slot.required) this.materializeReviewSlot(identity, request, slot, authorSubject, root, now);
    }
  }

  reconcileReviewDecision(reviewRequestId: string, now = Date.now()): Record<string, unknown> {
    const request = this.reviewPool.getRequest(required(reviewRequestId, 'Review request id'));
    if (request.status !== 'approved') return { reviewRequestId: request.id, status: request.status };
    const change = this.changes.getChangeRequest(request.changeRequestId);
    const slots = this.reviewPool.listSlots(request.id);
    const reviewer = slots.find((slot) => slot.reviewerAgentId)?.reviewerAgentId;
    if (!reviewer) throw new Error('Approved Review Request has no reviewer identity');
    if (change.status === 'open') {
      this.changes.review({
        changeRequestId: change.id, reviewerSubject: reviewer, headSha: change.headSha, verdict: 'approve',
        body: slots.map((slot) => `${slot.dimension}: ${slot.decisionNote ?? 'approved'}`).join('\\n'),
      }, now);
    }
    const current = this.changes.getChangeRequest(change.id);
    const queued = this.changes.listQueue(change.projectId).find((entry) => entry.changeRequestId === current.id && ['queued','validating','integrated'].includes(entry.status))
      ?? this.changes.queue(current.id, now);
    const prepared = queued.status === 'queued' ? this.changes.prepareMergeCandidate(queued.id, now) : queued;
    if (prepared.status !== 'validating' || !prepared.candidateSha || !prepared.candidateBaseSha) {
      throw new Error('Approved Change Request did not produce a merge candidate');
    }
    const targetRef = `refs/heads/${current.targetBranch}`;
    const promotion = this.promotions.request({
      projectId: current.projectId, idempotencyKey: `organization-promotion:${request.id}:${request.revision}`,
      claimId: current.claimId, candidateSha: prepared.candidateSha, targetRef,
      expectedParentSha: prepared.candidateBaseSha, requestedBy: 'system:release-governor',
    }, now);
    const decided = promotion.status === 'pending' ? this.promotions.decide({
      promotionId: promotion.id, authoritySubject: 'system:release-governor', decision: 'approve',
      reason: 'All required Review Pool dimensions approved and machine evidence is exact-head valid',
    }, now) : promotion;
    const applied = decided.status === 'approved' ? this.promotions.apply({
      promotionId: decided.id, authoritySubject: 'system:release-governor',
    }, now) : decided;
    const integrated = this.changes.observeIntegration(prepared.id, now);
    this.database.db.prepare("UPDATE organization_review_work_items SET status='completed',updated_at=? WHERE review_request_id=? AND status='decided'")
      .run(now, request.id);
    this.event(current.projectId, 'ORGANIZATION_WORK_PROMOTED', request.id, {
      reviewRequestId: request.id, changeRequestId: current.id, queueEntryId: prepared.id,
      promotionId: applied.id, integratedSha: integrated.integratedSha ?? null,
    }, now);
    return { reviewRequestId: request.id, status: 'promoted', changeRequest: current, queue: integrated, promotion: applied };
  }

  reconcileVerifiedWork(
    claim: WorkClaim,
    verification: VerificationRecord,
    workspace: TaskWorkspace | undefined,
    now = Date.now(),
  ): OrganizationWorkflowReconciliation {
    const workItemId = claim.taskId.startsWith('org-work-') ? claim.taskId.slice('org-work-'.length) : '';
    const identity = this.organizationFor(workItemId);
    if (!identity?.organizationId || !identity.projectId) return { organizationId: '', workItemId, status: 'not-applicable' };
    if (verification.status !== 'passed' || !claim.commitSha || !workspace) {
      return { organizationId: identity.organizationId, workItemId, status: 'blocked', reason: 'Verified organization work lacks exact commit or durable workspace' };
    }
    try {
      const project = this.database.db.prepare('SELECT root_path FROM projects WHERE id=?').get(identity.projectId) as { root_path?: string } | undefined;
      const root = required(project?.root_path, 'Project root');
      const targetBranch = this.targetBranch(root, workspace.baseSha);
      const changeRequest = this.changes.listChangeRequests(identity.projectId).find((item) => item.taskId === claim.taskId && item.status !== 'closed')
        ?? this.changes.open({
          projectId: identity.projectId, taskId: claim.taskId, subject: claim.subject, branch: workspace.branch,
          targetBranch, baseSha: workspace.baseSha, headSha: claim.commitSha, claimId: claim.id,
        }, now);
      const reviewRequest = this.reviewPool.open({
        organizationId: identity.organizationId, changeRequestId: changeRequest.id, risk: 'normal',
        slots: [{ dimension: 'architecture', required: true }, { dimension: 'correctness', required: true }],
      }, now);
      const fullIdentity = { organizationId: identity.organizationId, projectId: identity.projectId, missionId: required(identity.missionId, 'Mission id') };
      this.materializeReviewWorks(fullIdentity, reviewRequest, claim.subject, root, now);
      this.event(identity.projectId, 'ORGANIZATION_WORK_REVIEW_READY', workItemId, { claimId: claim.id, changeRequestId: changeRequest.id, reviewRequestId: reviewRequest.id, headSha: claim.commitSha }, now);
      return { organizationId: identity.organizationId, workItemId, changeRequest, reviewRequest, status: 'review-ready' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.event(identity.projectId, 'ORGANIZATION_WORK_REVIEW_BLOCKED', workItemId, { claimId: claim.id, reason }, now);
      return { organizationId: identity.organizationId, workItemId, status: 'blocked', reason };
    }
  }
}
