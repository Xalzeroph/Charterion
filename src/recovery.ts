import type {
  ContentRecoveryState,
  SendAttemptRecord,
  SendAttemptState,
} from './contracts';

export interface AttemptRecoveryObservation {
  tabId: number;
  state: ContentRecoveryState;
  authoritativeConversationKey?: string;
}

export interface AttemptRecoveryDecision {
  attemptId: string;
  nextState?: SendAttemptState;
  error?: string;
}

const SEND_STALE_MS = 2 * 60 * 1000;
const deliveredAttemptSets = new WeakMap<ContentRecoveryState, ReadonlySet<string>>();

function deliveredAttemptSet(state: ContentRecoveryState): ReadonlySet<string> {
  const cached = deliveredAttemptSets.get(state);
  if (cached) return cached;
  const indexed = new Set(state.deliveredAttemptIds);
  deliveredAttemptSets.set(state, indexed);
  return indexed;
}

function sameConversation(record: SendAttemptRecord, observation: AttemptRecoveryObservation): boolean {
  if (record.tabId !== observation.tabId || record.contentEpoch !== observation.state.observation.contentEpoch) return false;
  const observedKey = observation.state.snapshot.conversationKey;
  if (record.conversationKey === observedKey) return true;
  return record.conversationKey === 'url:https://chatgpt.com/' &&
    observedKey.startsWith('conversation:') && observation.authoritativeConversationKey === observedKey;
}

export function recoverAttempt(
  record: SendAttemptRecord,
  observation: AttemptRecoveryObservation | undefined,
  now = Date.now(),
): AttemptRecoveryDecision {
  if (record.state === 'reply-observed' || record.state === 'failed' || record.state === 'uncertain') {
    return { attemptId: record.attemptId };
  }
  if (record.state === 'prepared') {
    return {
      attemptId: record.attemptId,
      nextState: 'failed',
      error: 'Service worker restarted before browser dispatch; prompt was not sent',
    };
  }
  if (!observation || !sameConversation(record, observation)) {
    return {
      attemptId: record.attemptId,
      nextState: 'uncertain',
      error: 'Cannot safely reconstruct this browser delivery after extension restart',
    };
  }

  const pending = observation.state.pendingAttempt;
  const pendingMatches = pending?.attemptId === record.attemptId;
  const delivered = deliveredAttemptSet(observation.state).has(record.attemptId);

  if (record.state === 'dispatched') {
    if (pendingMatches && delivered) {
      return { attemptId: record.attemptId, nextState: 'acknowledged' };
    }
    if (pendingMatches && !delivered && now - pending.startedAt <= SEND_STALE_MS) {
      return { attemptId: record.attemptId };
    }
    return {
      attemptId: record.attemptId,
      nextState: 'uncertain',
      error: 'Dispatch started but durable page delivery evidence is incomplete after restart',
    };
  }

  if (record.state === 'acknowledged') {
    if (pendingMatches && delivered) return { attemptId: record.attemptId };
    return {
      attemptId: record.attemptId,
      nextState: 'uncertain',
      error: 'Prompt delivery was acknowledged but reply-correlation baseline is unavailable after restart',
    };
  }

  return { attemptId: record.attemptId };
}
