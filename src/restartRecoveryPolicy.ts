import { retainAttemptLedger } from './attemptLedger';
import { advanceAttempt } from './attempts';
import { recoverAttempt, type AttemptRecoveryObservation } from './recovery';
import type { AgentMessage, AgentTask, SendAttemptRecord } from './contracts';

export interface RestartRecoveryState {
  attempts: SendAttemptRecord[];
  tasks: readonly AgentTask[];
  messages: readonly AgentMessage[];
}

export function restartRecoveryCandidates(
  attempts: readonly SendAttemptRecord[],
): SendAttemptRecord[] {
  return attempts.filter((attempt) =>
    attempt.state === 'prepared' ||
    attempt.state === 'dispatched' ||
    attempt.state === 'acknowledged',
  );
}

export function applyRestartRecovery(
  current: RestartRecoveryState,
  candidates: readonly SendAttemptRecord[],
  observations: readonly AttemptRecoveryObservation[],
  now: () => number = Date.now,
): SendAttemptRecord[] | undefined {
  const byTab = new Map(observations.map((observation) => [observation.tabId, observation]));
  let attempts = current.attempts;
  let changed = false;

  for (const record of candidates) {
    const latest = attempts.find((attempt) => attempt.attemptId === record.attemptId);
    if (!latest || latest.state !== record.state) continue;
    const decision = recoverAttempt(latest, byTab.get(latest.tabId), now());
    if (!decision.nextState) continue;
    const next = advanceAttempt(latest, decision.nextState, now(), decision.error);
    if (next.state === latest.state && next.error === latest.error) continue;
    attempts = retainAttemptLedger(
      [...attempts.filter((attempt) => attempt.attemptId !== next.attemptId), next],
      current.tasks,
      current.messages,
    );
    changed = true;
  }

  return changed ? attempts : undefined;
}
