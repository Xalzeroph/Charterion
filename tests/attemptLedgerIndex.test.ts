import { describe, expect, it } from 'vitest';
import { createAttemptLedgerIndex } from '../src/attemptLedgerIndex';
import type { ChatSnapshot, SendAttemptRecord } from '../src/contracts';

function attempt(id: string, tabId: number, conversationKey: string): SendAttemptRecord {
  return {
    attemptId: id,
    batchId: 'batch',
    tabId,
    conversationKey,
    contentEpoch: 'epoch',
    state: 'acknowledged',
    textLength: 1,
    baselineAssistantMessageCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function snapshot(conversationKey: string, conversationId?: string): ChatSnapshot {
  return {
    conversationKey,
    ...(conversationId ? { conversationId } : {}),
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    status: 'idle',
    confidence: 'direct',
    signals: ['composer-ready'],
    assistantMessageCount: 0,
    latestAssistantText: '',
    observedAt: 1,
  };
}

describe('attempt ledger index', () => {
  it('keeps new-chat identity scoped to the physical tab', () => {
    const index = createAttemptLedgerIndex([attempt('a1', 1, 'url:https://chatgpt.com/')]);
    expect(index.latestFor(1, snapshot('url:https://chatgpt.com/'))?.attemptId).toBe('a1');
    expect(index.latestFor(2, snapshot('url:https://chatgpt.com/'))).toBeUndefined();
  });

  it('reconnects a durable conversation after it moves to another tab', () => {
    const index = createAttemptLedgerIndex([attempt('a1', 1, 'conversation:abc')]);
    expect(index.latestFor(99, snapshot('conversation:abc', 'abc'))?.attemptId).toBe('a1');
  });

  it('returns the newest match across tab and durable conversation identities', () => {
    const index = createAttemptLedgerIndex([
      attempt('tab-old', 7, 'url:https://chatgpt.com/'),
      attempt('conversation-new', 9, 'conversation:new-id'),
    ]);
    expect(index.latestFor(7, snapshot('conversation:new-id', 'new-id'))?.attemptId).toBe('conversation-new');
  });

  it('prefers a newer physical-tab attempt over an older conversation match', () => {
    const index = createAttemptLedgerIndex([
      attempt('conversation-old', 9, 'conversation:new-id'),
      attempt('tab-new', 7, 'url:https://chatgpt.com/'),
    ]);
    expect(index.latestFor(7, snapshot('conversation:new-id', 'new-id'))?.attemptId).toBe('tab-new');
  });
});
