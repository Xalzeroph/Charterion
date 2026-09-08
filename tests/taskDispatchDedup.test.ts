import { describe, expect, it } from 'vitest';
import { dispatchReadyManagedTasks } from '../src/taskDispatchRuntime';
import type { AgentTask, ManagedTab, ManagedTask } from '../src/contracts';
import type { NativeControlSnapshot } from '../src/nativeControl';

function fixture(updatedAt = 1): { managed: ManagedTask; tab: ManagedTab; control: NativeControlSnapshot } {
  const task: AgentTask = {
    id: 'task-1', kind: 'work', completionPolicy: 'reply', title: 'Task', project: 'P',
    instruction: 'Do the task', targetRole: 'worker', dependsOn: [], attemptIds: [],
    createdAt: 1, updatedAt,
  };
  const managed: ManagedTask = { task, status: 'ready', attemptHistory: [] };
  const tab: ManagedTab = {
    tabId: 7, windowId: 1, active: false,
    binding: { role: 'worker', project: 'P', notes: '', agentSlotId: 'slot-1' },
    snapshot: {
      conversationKey: 'conversation:c1', title: 'Worker', url: 'https://chatgpt.com/c/c1',
      status: 'idle', confidence: 'direct', signals: [], assistantMessageCount: 0,
      latestAssistantText: '', observedAt: 1,
    },
  };
  const control: NativeControlSnapshot = {
    protocolVersion: 2, projects: [], resources: [], leases: [], changeRequests: [], reviews: [],
    mergeQueue: [], workerRequests: [], browserRuntime: [], events: [],
    agents: [{
      id: 'slot-1', projectId: 'project-1', role: 'worker', status: 'idle', desiredState: 'active',
      browserState: 'open', conversationGeneration: 1, rolloverState: 'idle', browserQuarantined: false, leaseEpoch: 1,
    }],
  };
  return { managed, tab, control };
}

describe('task dispatch revision deduplication', () => {
  it('allows only one concurrent dispatch from the same stale task revision', async () => {
    const { managed, tab, control } = fixture();
    let calls = 0;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = async (tabId: number) => {
      calls += 1;
      entered();
      await gate;
      return { tabId, attemptId: 'attempt-1', ok: true };
    };

    const first = dispatchReadyManagedTasks([managed], [tab], control, { 'slot-1': 7 }, 'batch-1', dispatch);
    await started;
    const duplicate = await dispatchReadyManagedTasks([managed], [tab], control, { 'slot-1': 7 }, 'batch-2', dispatch);

    expect(duplicate).toEqual([{
      taskId: 'task-1', ok: false, error: 'Task dispatch is already in flight for this task revision',
    }]);
    expect(calls).toBe(1);

    release();
    await expect(first).resolves.toEqual([{ taskId: 'task-1', ok: true, attemptId: 'attempt-1' }]);
  });

  it('allows a later changed task revision to dispatch normally', async () => {
    const first = fixture(1);
    const second = fixture(2);
    const results = await dispatchReadyManagedTasks(
      [second.managed], [second.tab], second.control, { 'slot-1': 7 }, 'batch-fresh',
      async (tabId) => ({ tabId, attemptId: 'attempt-fresh', ok: true }),
    );
    expect(first.managed.task.updatedAt).not.toBe(second.managed.task.updatedAt);
    expect(results).toEqual([{ taskId: 'task-1', ok: true, attemptId: 'attempt-fresh' }]);
  });
});
