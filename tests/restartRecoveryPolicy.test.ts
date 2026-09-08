import { describe, expect, it } from 'vitest';
import { applyRestartRecovery, restartRecoveryCandidates } from '../src/restartRecoveryPolicy';
import type { SendAttemptRecord } from '../src/contracts';

function attempt(id: string, state: SendAttemptRecord['state']): SendAttemptRecord {
  return {
    attemptId: id,
    batchId: 'batch',
    tabId: 7,
    conversationKey: 'conversation:abc',
    contentEpoch: 'epoch',
    state,
    textLength: 1,
    baselineAssistantMessageCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('restart recovery policy', () => {
  it('selects only restart-sensitive attempt states', () => {
    const attempts = [
      attempt('prepared', 'prepared'),
      attempt('dispatched', 'dispatched'),
      attempt('acknowledged', 'acknowledged'),
      attempt('done', 'reply-observed'),
    ];
    expect(restartRecoveryCandidates(attempts).map((item) => item.attemptId))
      .toEqual(['prepared', 'dispatched', 'acknowledged']);
  });

  it('fails prepared attempts because dispatch never became observable', () => {
    const prepared = attempt('prepared', 'prepared');
    const recovered = applyRestartRecovery(
      { attempts: [prepared], tasks: [], messages: [] },
      [prepared],
      [],
      () => 100,
    );

    expect(recovered?.[0]).toMatchObject({ attemptId: 'prepared', state: 'failed', updatedAt: 100 });
    expect(recovered?.[0]?.error).toContain('prompt was not sent');
  });

  it('marks an unobservable dispatched attempt uncertain', () => {
    const dispatched = attempt('dispatched', 'dispatched');
    const recovered = applyRestartRecovery(
      { attempts: [dispatched], tasks: [], messages: [] },
      [dispatched],
      [],
      () => 200,
    );
    expect(recovered?.[0]).toMatchObject({ attemptId: 'dispatched', state: 'uncertain', updatedAt: 200 });
  });

  it('does not overwrite a candidate whose state changed before the mutation lock', () => {
    const candidate = attempt('race', 'dispatched');
    const current = attempt('race', 'acknowledged');
    const recovered = applyRestartRecovery(
      { attempts: [current], tasks: [], messages: [] },
      [candidate],
      [],
      () => 300,
    );

    expect(recovered).toBeUndefined();
    expect(current.state).toBe('acknowledged');
  });
});
