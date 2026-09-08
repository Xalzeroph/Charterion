import type { AgentMessage } from './contracts';
import type { ControlReviewView, NativeControlSnapshot } from './nativeControl';

export const CONTROL_REVIEW_FEEDBACK_PREFIX = 'control-review-feedback:';
export const CONTROL_MERGE_FAILURE_PREFIX = 'control-merge-failure:';

function messageBase(
  id: string,
  project: string,
  fromRole: string,
  targetRole: string,
  type: AgentMessage['type'],
  content: string,
  taskId: string,
  at: number,
): AgentMessage {
  return {
    id, project, fromRole, target: { kind: 'role', role: targetRole }, type, content,
    taskId, attemptIds: [], createdAt: at, updatedAt: at,
  };
}

function reviewKey(changeRequestId: string, headSha: string): string {
  return `${changeRequestId}\u0000${headSha}`;
}

function latestReviews(snapshot: NativeControlSnapshot): Map<string, ControlReviewView> {
  const latest = new Map<string, ControlReviewView>();
  for (const review of snapshot.reviews) {
    const key = reviewKey(review.changeRequestId, review.headSha);
    const current = latest.get(key);
    if (!current || review.createdAt >= current.createdAt) latest.set(key, review);
  }
  return latest;
}

export function controlFeedbackMessages(
  snapshot: NativeControlSnapshot,
  existingIds: ReadonlySet<string> = new Set(),
): AgentMessage[] {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const changes = new Map(snapshot.changeRequests.map((change) => [change.id, change]));
  const reviews = latestReviews(snapshot);
  const result: AgentMessage[] = [];

  for (const change of snapshot.changeRequests) {
    if (change.status !== 'changes-requested') continue;
    const author = agents.get(change.authorSubject);
    const project = projects.get(change.projectId);
    if (!author || !project) continue;
    const latestReview = reviews.get(reviewKey(change.id, change.headSha));
    if (!latestReview || latestReview.verdict !== 'request-changes') continue;
    const id = `${CONTROL_REVIEW_FEEDBACK_PREFIX}${latestReview.id}`;
    if (existingIds.has(id)) continue;
    const reviewerRole = agents.get(latestReview.reviewerSubject)?.role ?? 'SUPERVISOR';
    const content = [
      `Kernel review feedback for Change Request ${change.id}.`,
      `Reviewed head: ${change.headSha}`,
      '', latestReview.body,
      '', 'Address this feedback, produce a new verified commit, and submit a new Change Request revision.',
    ].join('\n');
    result.push(messageBase(
      id, project.name, reviewerRole, author.role, 'review-result', content,
      change.taskId, latestReview.createdAt,
    ));
  }

  for (const queue of snapshot.mergeQueue) {
    if (queue.status !== 'failed') continue;
    const change = changes.get(queue.changeRequestId);
    if (!change || change.status !== 'changes-requested') continue;
    const author = agents.get(change.authorSubject);
    const project = projects.get(change.projectId);
    if (!author || !project) continue;
    const id = `${CONTROL_MERGE_FAILURE_PREFIX}${queue.id}`;
    if (existingIds.has(id)) continue;
    const content = [
      `Kernel merge candidate failed for Change Request ${change.id}.`,
      `Reviewed head: ${queue.headSha}`,
      `Target branch: ${queue.targetBranch}`,
      '', queue.error ?? 'The merge candidate could not be validated.',
      '', 'Rebase or repair the branch, re-run verification, then submit a new Change Request revision.',
    ].join('\n');
    result.push(messageBase(
      id, project.name, 'SUPERVISOR', author.role, 'blocker', content,
      change.taskId, queue.updatedAt,
    ));
  }
  return result;
}
