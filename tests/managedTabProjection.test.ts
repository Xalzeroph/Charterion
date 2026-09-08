import { describe, expect, it } from 'vitest';
import { projectManagedTabs } from '../src/managedTabProjection';
import type { ChatSnapshot, SendAttemptRecord } from '../src/contracts';

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

describe('managed tab projection', () => {
  it('sorts observations and attaches bindings plus the latest matching attempt', () => {
    const observations = [
      { tabId: 9, windowId: 2, active: false, snapshot: snapshot('conversation:abc', 'abc') },
      { tabId: 2, windowId: 1, active: true, snapshot: snapshot('url:https://chatgpt.com/') },
    ];
    const attempts = [
      attempt('new-chat', 2, 'url:https://chatgpt.com/'),
      attempt('durable', 1, 'conversation:abc'),
    ];
    const projected = projectManagedTabs(observations, attempts, (tabId) => ({ role: `ROLE-${tabId}`, project: 'P', notes: '' }));

    expect(projected.map((tab) => tab.tabId)).toEqual([2, 9]);
    expect(projected[0]?.binding.role).toBe('ROLE-2');
    expect(projected[0]?.lastAttempt?.attemptId).toBe('new-chat');
    expect(projected[1]?.lastAttempt?.attemptId).toBe('durable');
  });
});
