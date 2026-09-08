import { randomUUID } from 'node:crypto';
import type { ControlDatabase } from './database';
import type {
  ClaimReviewSlotInput,
  DecideReviewSlotInput,
  OpenReviewRequestInput,
  ReviewQueueItem,
  ReviewRequestRecord,
  ReviewRequestStatus,
  ReviewRisk,
  ReviewSlotRecord,
  ReviewSlotState,
} from './reviewPoolContracts';

type Row = Record<string, string | number | null | undefined>;

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

const RISK_WEIGHT: Record<ReviewRisk, number> = { low: 1, normal: 2, high: 3, critical: 4 };
function requestFrom(row: Row): ReviewRequestRecord {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    changeRequestId: String(row.change_request_id), revision: Number(row.revision), headSha: String(row.head_sha),
    authorSubject: String(row.author_subject), risk: String(row.risk) as ReviewRisk,
    status: String(row.status) as ReviewRequestStatus, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function slotFrom(row: Row): ReviewSlotRecord {
  const value: ReviewSlotRecord = {
    id: String(row.id), reviewRequestId: String(row.review_request_id), dimension: String(row.dimension),
    required: Number(row.required) === 1, state: String(row.state) as ReviewSlotState,
  };
  if (row.required_domain_id !== null) value.requiredDomainId = String(row.required_domain_id);
  if (row.reviewer_agent_id !== null) value.reviewerAgentId = String(row.reviewer_agent_id);
  if (row.claimed_at !== null) value.claimedAt = Number(row.claimed_at);
  if (row.decided_at !== null) value.decidedAt = Number(row.decided_at);
  if (row.decision_note !== null) value.decisionNote = String(row.decision_note);
  return value;
}
export class ReviewPoolAuthority {
  constructor(private readonly database: ControlDatabase) {}

  private event(projectId: string, type: string, subject: string, payload: Record<string, unknown>, now: number): void {
    this.database.db.prepare('INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(projectId, type, subject, JSON.stringify(payload), now);
  }

  getRequest(id: string): ReviewRequestRecord {
    const row = this.database.db.prepare('SELECT * FROM review_requests WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error(`Review request ${id} does not exist`);
    return requestFrom(row);
  }

  getSlot(id: string): ReviewSlotRecord {
    const row = this.database.db.prepare('SELECT * FROM review_slots WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error(`Review slot ${id} does not exist`);
    return slotFrom(row);
  }

  listSlots(reviewRequestId: string): ReviewSlotRecord[] {
    return (this.database.db.prepare('SELECT * FROM review_slots WHERE review_request_id=? ORDER BY rowid').all(reviewRequestId) as Row[]).map(slotFrom);
  }
  open(input: OpenReviewRequestInput, now = Date.now()): ReviewRequestRecord {
    const organizationId = required(input.organizationId, 'Organization id');
    const changeRequestId = required(input.changeRequestId, 'Change request id');
    if (input.slots.length === 0) throw new Error('Review request needs at least one review slot');
    return this.database.transaction(() => {
      const organization = this.database.db.prepare('SELECT status FROM organizations WHERE id=?').get(organizationId) as { status?: string } | undefined;
      if (organization?.status !== 'active') throw new Error('Review request requires an active Organization');
      const change = this.database.db.prepare('SELECT project_id,author_subject,head_sha,claim_id,revision,status FROM change_requests WHERE id=?').get(changeRequestId) as {
        project_id?: string; author_subject?: string; head_sha?: string; claim_id?: string; revision?: number; status?: string;
      } | undefined;
      if (!change?.project_id || !change.author_subject || !change.head_sha || !change.claim_id || !change.revision) throw new Error(`Change request ${changeRequestId} does not exist`);
      if (!['open','changes-requested','approved'].includes(change.status ?? '')) throw new Error('Change request is not reviewable');
      const claim = this.database.db.prepare('SELECT status,commit_sha FROM claims WHERE id=?').get(change.claim_id) as { status?: string; commit_sha?: string | null } | undefined;
      const passed = this.database.db.prepare("SELECT id FROM verifications WHERE claim_id=? AND status='passed' ORDER BY completed_at DESC LIMIT 1").get(change.claim_id) as { id?: string } | undefined;
      if (claim?.status !== 'verified' || claim.commit_sha !== change.head_sha || !passed?.id) throw new Error('Semantic review requires exact-head machine evidence first');
      const existing = this.database.db.prepare('SELECT * FROM review_requests WHERE change_request_id=? AND revision=?').get(changeRequestId, change.revision) as Row | undefined;
      if (existing) {
        const current = requestFrom(existing);
        if (current.headSha !== change.head_sha) throw new Error('Existing review request head does not match current ChangeRequest');
        return current;
      }
      const normalizedSlots = input.slots.map((slot) => ({
        dimension: required(slot.dimension, 'Review dimension'),
        required: slot.required !== false,
        requiredDomainId: slot.requiredDomainId?.trim() || undefined,
      }));
      const dimensionKeys = new Set<string>();
      for (const slot of normalizedSlots) {
        const key = `${slot.dimension}\u0000${slot.requiredDomainId ?? ''}`;
        if (dimensionKeys.has(key)) throw new Error('Duplicate review slot dimension/domain');
        dimensionKeys.add(key);
        if (slot.requiredDomainId) {
          const domain = this.database.db.prepare('SELECT organization_id,status FROM organization_domains WHERE id=?').get(slot.requiredDomainId) as { organization_id?: string; status?: string } | undefined;
          if (domain?.organization_id !== organizationId || domain.status !== 'active') throw new Error('Required review Domain is not active in this Organization');
        }
      }
      const id = randomUUID();
      const risk = input.risk ?? 'normal';
      this.database.db.prepare(`INSERT INTO review_requests(id,organization_id,project_id,change_request_id,revision,head_sha,author_subject,risk,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?, 'open',?,?)`).run(id, organizationId, change.project_id, changeRequestId, change.revision, change.head_sha, change.author_subject, risk, now, now);
      for (const slot of normalizedSlots) {
        this.database.db.prepare(`INSERT INTO review_slots(id,review_request_id,dimension,required,required_domain_id,state,reviewer_agent_id,claimed_at,decided_at,decision_note)
          VALUES(?,?,?,?,?,'open',NULL,NULL,NULL,NULL)`)
          .run(randomUUID(), id, slot.dimension, slot.required ? 1 : 0, slot.requiredDomainId ?? null);
      }
      this.event(change.project_id, 'REVIEW_REQUEST_OPENED', id, { changeRequestId, revision: change.revision, headSha: change.head_sha, risk, slots: normalizedSlots }, now);
      return this.getRequest(id);
    });
  }

  private reviewer(agentId: string): { id: string; organizationId: string; runtimeSlotId?: string } {
    const row = this.database.db.prepare('SELECT id,organization_id,runtime_slot_id,status FROM organization_agents WHERE id=?').get(agentId) as {
      id?: string; organization_id?: string; runtime_slot_id?: string | null; status?: string;
    } | undefined;
    if (!row?.id || !row.organization_id || row.status !== 'active') throw new Error('Reviewer must be an active Organization Agent');
    return { id: row.id, organizationId: row.organization_id, ...(row.runtime_slot_id ? { runtimeSlotId: row.runtime_slot_id } : {}) };
  }

  private eligible(request: ReviewRequestRecord, slot: ReviewSlotRecord, reviewerAgentId: string): boolean {
    const reviewer = this.reviewer(reviewerAgentId);
    if (reviewer.organizationId !== request.organizationId) return false;
    if (request.authorSubject === reviewer.id || request.authorSubject === reviewer.runtimeSlotId) return false;
    if (slot.requiredDomainId) {
      const assignment = this.database.db.prepare('SELECT 1 AS ok FROM agent_domain_assignments WHERE agent_id=? AND domain_id=?').get(reviewer.id, slot.requiredDomainId) as { ok?: number } | undefined;
      if (!assignment?.ok) return false;
    }
    return true;
  }
  queueForAgent(agentId: string, now = Date.now()): ReviewQueueItem[] {
    const reviewer = this.reviewer(agentId);
    // Candidate discovery is a read-only set operation; claim() revalidates authority inside its transaction.
    const selfReviewFilter = reviewer.runtimeSlotId
      ? 'AND r.author_subject<>? AND r.author_subject<>?'
      : 'AND r.author_subject<>?';
    const query = `SELECT s.*, r.organization_id,r.project_id,r.change_request_id,r.revision,r.head_sha,r.author_subject,r.risk,r.status AS request_status,r.created_at AS request_created_at,r.updated_at AS request_updated_at
      FROM review_slots s
      JOIN review_requests r ON r.id=s.review_request_id
      LEFT JOIN agent_domain_assignments a ON a.agent_id=? AND a.domain_id=s.required_domain_id
      WHERE s.state='open' AND r.status='open' AND r.organization_id=?
        AND (s.required_domain_id IS NULL OR a.agent_id IS NOT NULL)
        ${selfReviewFilter}`;
    const selfReviewParams = reviewer.runtimeSlotId ? [reviewer.id, reviewer.runtimeSlotId] : [reviewer.id];
    const rows = this.database.db.prepare(query).all(reviewer.id, reviewer.organizationId, ...selfReviewParams) as Row[];
    const items = rows.map((row) => {
      const request = requestFrom({
        id: row.review_request_id, organization_id: row.organization_id, project_id: row.project_id, change_request_id: row.change_request_id,
        revision: row.revision, head_sha: row.head_sha, author_subject: row.author_subject, risk: row.risk,
        status: row.request_status, created_at: row.request_created_at, updated_at: row.request_updated_at,
      });
      return { request, slot: slotFrom(row), ageMs: Math.max(0, now - request.createdAt) };
    });
    return items.sort((a, b) => RISK_WEIGHT[b.request.risk] - RISK_WEIGHT[a.request.risk] || b.ageMs - a.ageMs || a.slot.id.localeCompare(b.slot.id));
  }
  claim(input: ClaimReviewSlotInput, now = Date.now()): ReviewSlotRecord {
    return this.database.transaction(() => {
      const slot = this.getSlot(input.slotId);
      const request = this.getRequest(slot.reviewRequestId);
      if (request.status !== 'open' || slot.state !== 'open') throw new Error('Review slot is not claimable');
      if (!this.eligible(request, slot, input.reviewerAgentId)) throw new Error('Reviewer is not eligible for this review slot');
      this.database.db.prepare("UPDATE review_slots SET state='claimed',reviewer_agent_id=?,claimed_at=? WHERE id=? AND state='open'")
        .run(input.reviewerAgentId, now, slot.id);
      this.database.db.prepare("UPDATE organization_review_work_items SET status='claimed',updated_at=? WHERE review_slot_id=? AND status='materialized'")
        .run(now, slot.id);
      const claimed = this.getSlot(slot.id);
      if (claimed.reviewerAgentId !== input.reviewerAgentId || claimed.state !== 'claimed') throw new Error('Review slot claim lost a concurrency race');
      this.event(request.projectId, 'REVIEW_SLOT_CLAIMED', slot.id, { reviewRequestId: request.id, reviewerAgentId: input.reviewerAgentId, dimension: slot.dimension }, now);
      return claimed;
    });
  }

  private reconcile(requestId: string, now: number): ReviewRequestRecord {
    const request = this.getRequest(requestId);
    const slots = this.listSlots(request.id);
    let status: ReviewRequestStatus = 'open';
    if (slots.some((slot) => slot.state === 'rejected')) status = 'rejected';
    else if (slots.some((slot) => slot.state === 'changes-requested')) status = 'changes-requested';
    else if (slots.filter((slot) => slot.required).every((slot) => slot.state === 'approved')) status = 'approved';
    if (status !== request.status) {
      this.database.db.prepare('UPDATE review_requests SET status=?,updated_at=? WHERE id=?').run(status, now, request.id);
      this.event(request.projectId, 'REVIEW_REQUEST_STATUS_CHANGED', request.id, { from: request.status, to: status }, now);
    }
    return this.getRequest(request.id);
  }
  decide(input: DecideReviewSlotInput, now = Date.now()): { slot: ReviewSlotRecord; request: ReviewRequestRecord } {
    return this.database.transaction(() => {
      const slot = this.getSlot(input.slotId);
      const request = this.getRequest(slot.reviewRequestId);
      if (slot.state !== 'claimed' || slot.reviewerAgentId !== input.reviewerAgentId) throw new Error('Only the claiming reviewer may decide this review slot');
      const note = required(input.note, 'Review decision note');
      const state: ReviewSlotState = input.decision === 'approve' ? 'approved' : input.decision === 'request-changes' ? 'changes-requested' : 'rejected';
      this.database.db.prepare('UPDATE review_slots SET state=?,decided_at=?,decision_note=? WHERE id=?')
        .run(state, now, note, slot.id);
      this.database.db.prepare("UPDATE organization_review_work_items SET status='decided',updated_at=? WHERE review_slot_id=? AND status IN ('materialized','claimed')")
        .run(now, slot.id);
      this.event(request.projectId, 'REVIEW_SLOT_DECIDED', slot.id, { reviewRequestId: request.id, reviewerAgentId: input.reviewerAgentId, dimension: slot.dimension, decision: input.decision }, now);
      return { slot: this.getSlot(slot.id), request: this.reconcile(request.id, now) };
    });
  }
}
