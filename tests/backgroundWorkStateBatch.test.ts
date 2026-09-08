import { describe, expect, it } from 'vitest';
import { planWorkPatchMutations, type WorkState } from '../src/backgroundWorkState';
import type { AgentMessage, AgentTask, SendAttemptRecord } from '../src/contracts';

const task = (id: string, attemptIds: string[] = []): AgentTask => ({
  id, kind: 'work', completionPolicy: 'reply', title: id, project: 'P', instruction: 'do',
  targetRole: 'worker', dependsOn: [], attemptIds, createdAt: 1, updatedAt: 1,
});
const attempt = (id: string, taskId: string): SendAttemptRecord => ({
  attemptId: id, batchId: 'b', tabId: 1, conversationKey: 'conversation:c1', contentEpoch: 'e',
  taskId, state: 'prepared', textLength: 1, baselineAssistantMessageCount: 0, createdAt: 1, updatedAt: 1,
});
const message = (id: string): AgentMessage => ({
  id, project: 'P', fromRole: 'worker', target: { kind: 'project' }, type: 'result',
  content: id, attemptIds: [], createdAt: 1, updatedAt: 1,
});

function state(): WorkState {
  return { revision: 5, tasks: [task('t1')], attempts: [], messages: [message('m1')] };
}

describe('automatic work batch planning', () => {
  it('batches changed owners and appended attempts without replacing the ledger', () => {
    const current = state();
    const nextTask = { ...current.tasks[0]!, attemptIds: ['a1'], updatedAt: 2 };
    const mutations = planWorkPatchMutations(current, {
      tasks: [nextTask], attempts: [attempt('a1', 't1')], messages: current.messages,
    });
    expect(mutations).toEqual([
      { kind: 'task', document: nextTask },
      { kind: 'attempt', document: expect.objectContaining({ attemptId: 'a1', taskId: 't1' }) },
    ]);
  });

  it('falls back to full replacement when a collection deletes or reorders documents', () => {
    const current: WorkState = {
      revision: 1, tasks: [task('t1'), task('t2')], attempts: [], messages: [],
    };
    expect(planWorkPatchMutations(current, { tasks: [current.tasks[0]!], attempts: [], messages: [] })).toBeUndefined();
    expect(planWorkPatchMutations(current, { tasks: [current.tasks[1]!, current.tasks[0]!], attempts: [], messages: [] })).toBeUndefined();
  });

  it('falls back when the patch exceeds the automatic batch limit', () => {
    const current = state();
    const extra = Array.from({ length: 9 }, (_, index) => message(`extra-${index}`));
    expect(planWorkPatchMutations(current, {
      tasks: current.tasks,
      attempts: current.attempts,
      messages: [...current.messages, ...extra],
    }, 8)).toBeUndefined();
  });
});
