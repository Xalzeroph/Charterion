import type { AgentMessage, AgentTask, SendAttemptRecord } from './contracts';

export const MAX_UNLINKED_SEND_ATTEMPTS = 500;

export function retainAttemptLedger(
  attempts: readonly SendAttemptRecord[],
  tasks: readonly AgentTask[],
  messages: readonly AgentMessage[],
  maxUnlinked = MAX_UNLINKED_SEND_ATTEMPTS,
): SendAttemptRecord[] {
  const linkedIds = new Set<string>();
  for (const task of tasks) for (const id of task.attemptIds) linkedIds.add(id);
  for (const message of messages) for (const id of message.attemptIds) linkedIds.add(id);

  const retainedUnlinked = new Set<string>();
  let remaining = Math.max(0, maxUnlinked);
  for (let index = attempts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const attempt = attempts[index]!;
    if (linkedIds.has(attempt.attemptId) || attempt.taskId || attempt.messageId) continue;
    retainedUnlinked.add(attempt.attemptId);
    remaining -= 1;
  }

  return attempts.filter((attempt) =>
    linkedIds.has(attempt.attemptId) ||
    Boolean(attempt.taskId) ||
    Boolean(attempt.messageId) ||
    retainedUnlinked.has(attempt.attemptId),
  );
}
