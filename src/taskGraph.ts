import { parseReviewResult } from './review';
import { parseStructuredTaskResult } from './structuredResult';
import { DEFAULT_MAX_REVIEW_ROUNDS, validateTaskPolicy } from './taskPolicy';
import type { AgentTask, ManagedTask, ReviewResult, SendAttemptRecord, StructuredTaskResult, TaskDisplayStatus } from './contracts';

const BLOCKING_DEPENDENCY_STATES = new Set<TaskDisplayStatus>(['error', 'attention', 'blocked', 'cancelled', 'rejected']);

export function validateTaskGraph(tasks: readonly AgentTask[]): void {
  const byId = new Map<string, AgentTask>();
  for (const task of tasks) byId.set(task.id, task);
  if (byId.size !== tasks.length) throw new Error('Task ids must be unique');
  for (const task of tasks) {
    if (!task.title.trim() || !task.instruction.trim()) {
      throw new Error('Task title and instruction are required');
    }
    validateTaskPolicy(task);
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
      if (!byId.has(dependency)) throw new Error(`Task ${task.id} depends on missing task ${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error('Task dependencies must form a DAG');
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

interface AttemptEvaluation {
  status?: TaskDisplayStatus;
  reviewResult?: ReviewResult;
  reviewError?: string;
  structuredResult?: StructuredTaskResult;
  structuredResultError?: string;
}

function evaluateAttempt(task: AgentTask, attempt: SendAttemptRecord | undefined): AttemptEvaluation {
  if (task.completionPolicy === 'verified-claim' && task.machineCompletion) return { status: 'completed' };
  switch (attempt?.state) {
    case 'reply-observed': {
      if (task.completionPolicy === 'verified-claim') return { status: 'running' };
      if (task.completionPolicy === 'structured-result') {
        const parsed = parseStructuredTaskResult(attempt.replyTextTail ?? '');
        return parsed.ok
          ? { status: 'completed', structuredResult: parsed.result }
          : { status: 'attention', structuredResultError: parsed.error };
      }
      if (task.kind !== 'review') return { status: 'completed' };
      const parsed = parseReviewResult(attempt.replyTextTail ?? '');
      if (!parsed.ok) return { status: 'attention', reviewError: parsed.error };
      if (parsed.result.decision === 'fail') return { status: 'attention', reviewResult: parsed.result };
      return { status: 'completed', reviewResult: parsed.result };
    }
    case 'prepared':
    case 'dispatched':
    case 'acknowledged': return { status: 'running' };
    case 'failed': return { status: 'error' };
    case 'uncertain': return { status: 'attention' };
    default: return {};
  }
}

function reviewAttemptsExhausted(task: AgentTask): boolean {
  return task.kind === 'review' &&
    task.attemptIds.length >= (task.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS);
}

function isRetryableEvaluatedAttempt(
  task: AgentTask,
  attempt: SendAttemptRecord | undefined,
  evaluation: AttemptEvaluation,
  reviewExhausted = reviewAttemptsExhausted(task),
): boolean {
  if (!attempt) return false;
  if (attempt.state === 'failed' || attempt.state === 'uncertain') {
    return task.kind !== 'review' || !reviewExhausted;
  }
  if (attempt.state === 'reply-observed' && task.completionPolicy === 'structured-result') {
    return evaluation.structuredResultError !== undefined;
  }
  if (task.kind !== 'review' || attempt.state !== 'reply-observed' || reviewExhausted) return false;
  return evaluation.reviewError !== undefined || evaluation.reviewResult?.decision === 'fail';
}

export function isRetryableTaskAttempt(task: AgentTask, attempt: SendAttemptRecord | undefined): boolean {
  return isRetryableEvaluatedAttempt(task, attempt, evaluateAttempt(task, attempt));
}

function isReviewRevisionRetry(task: AgentTask, attempt: SendAttemptRecord | undefined): boolean {
  return Boolean(
    task.kind === 'work' &&
    attempt?.state === 'reply-observed' &&
    task.retryAfterAttemptId === attempt.attemptId &&
    task.revisionFromReviewAttemptId,
  );
}

function attemptHistoryForTask(task: AgentTask, attemptsById: ReadonlyMap<string, SendAttemptRecord>): SendAttemptRecord[] {
  const history: SendAttemptRecord[] = [];
  for (const id of task.attemptIds) {
    const attempt = attemptsById.get(id);
    if (attempt) history.push(attempt);
  }
  return history;
}

export function deriveManagedTasks(
  tasks: readonly AgentTask[],
  attempts: readonly SendAttemptRecord[],
): ManagedTask[] {
  const tasksById = new Map<string, AgentTask>();
  for (const task of tasks) tasksById.set(task.id, task);
  const attemptsById = new Map<string, SendAttemptRecord>();
  for (const attempt of attempts) attemptsById.set(attempt.attemptId, attempt);
  const result = new Map<string, ManagedTask>();

  const derive = (task: AgentTask): ManagedTask => {
    const cached = result.get(task.id);
    if (cached) return cached;
    const attemptHistory = attemptHistoryForTask(task, attemptsById);
    const lastAttempt = attemptHistory.at(-1);
    const observedEvaluation = evaluateAttempt(task, lastAttempt);
    const reviewExhausted = reviewAttemptsExhausted(task);
    const retryRequested = Boolean(
      lastAttempt &&
      task.retryAfterAttemptId === lastAttempt.attemptId &&
      (isRetryableEvaluatedAttempt(task, lastAttempt, observedEvaluation, reviewExhausted) || isReviewRevisionRetry(task, lastAttempt)),
    );
    const evaluation = retryRequested ? {} : observedEvaluation;
    const reviewLoopExhausted = Boolean(
      task.kind === 'review' &&
      evaluation.status === 'attention' &&
      reviewExhausted,
    );

    let status: TaskDisplayStatus;
    if (task.cancelledAt !== undefined) {
      status = 'cancelled';
    } else if (task.skippedAt !== undefined) {
      status = 'skipped';
    } else if (evaluation.status && !reviewLoopExhausted) {
      status = evaluation.status;
    } else if (reviewLoopExhausted) {
      status = 'error';
    } else {
      let dependencyBlocked = false;
      let dependenciesTerminal = true;
      for (const id of task.dependsOn) {
        const dependency = tasksById.get(id);
        if (!dependency) continue;
        const dependencyStatus = derive(dependency).status;
        if (BLOCKING_DEPENDENCY_STATES.has(dependencyStatus)) {
          dependencyBlocked = true;
          break;
        }
        if (dependencyStatus !== 'completed' && dependencyStatus !== 'skipped') dependenciesTerminal = false;
      }
      if (dependencyBlocked) {
        status = 'blocked';
      } else if (!dependenciesTerminal) {
        status = task.dependsOn.length === 0 ? 'ready' : 'pending';
      } else if (task.kind === 'human') {
        status = task.humanDecision?.decision === 'approve'
          ? 'completed'
          : task.humanDecision?.decision === 'reject'
            ? 'rejected'
            : 'waiting-human';
      } else {
        status = 'ready';
      }
    }

    const managed: ManagedTask = { task, status, attemptHistory };
    if (lastAttempt) managed.lastAttempt = lastAttempt;
    if (observedEvaluation.reviewResult) managed.reviewResult = observedEvaluation.reviewResult;
    if (observedEvaluation.reviewError) managed.reviewError = observedEvaluation.reviewError;
    if (observedEvaluation.structuredResult) managed.structuredResult = observedEvaluation.structuredResult;
    if (observedEvaluation.structuredResultError) managed.structuredResultError = observedEvaluation.structuredResultError;
    if (task.kind === 'review') {
      managed.reviewRound = attemptHistory.length;
      managed.reviewLoopExhausted = reviewLoopExhausted;
    }
    result.set(task.id, managed);
    return managed;
  };

  return tasks.map(derive);
}
