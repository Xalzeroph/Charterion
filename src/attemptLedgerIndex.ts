import type { ChatSnapshot, SendAttemptRecord } from './contracts';

interface IndexedAttempt {
  attempt: SendAttemptRecord;
  ordinal: number;
}

export interface AttemptLedgerIndex {
  latestFor(tabId: number, snapshot: ChatSnapshot): SendAttemptRecord | undefined;
}

export function createAttemptLedgerIndex(attempts: readonly SendAttemptRecord[]): AttemptLedgerIndex {
  const byTab = new Map<number, IndexedAttempt>();
  const byConversation = new Map<string, IndexedAttempt>();

  attempts.forEach((attempt, ordinal) => {
    const indexed = { attempt, ordinal };
    byTab.set(attempt.tabId, indexed);
    byConversation.set(attempt.conversationKey, indexed);
  });

  return {
    latestFor(tabId, snapshot) {
      let latest = byTab.get(tabId);
      if (snapshot.conversationId) {
        const conversationAttempt = byConversation.get(snapshot.conversationKey);
        if (conversationAttempt && (!latest || conversationAttempt.ordinal > latest.ordinal)) {
          latest = conversationAttempt;
        }
      }
      return latest?.attempt;
    },
  };
}
