import { afterEach, describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { WorkAuthority } from '../src/workAuthority';

const databases: ControlDatabase[] = [];
function harness(): WorkAuthority {
  const database = new ControlDatabase(':memory:');
  databases.push(database);
  return new WorkAuthority(database);
}
afterEach(() => { while (databases.length) databases.pop()?.close(); });

function transport(expectedRevision: number, messageId: string) {
  return {
    transportGeneration: 'generation-batch',
    transportSequence: expectedRevision + 1,
    transportMessageId: messageId,
  };
}

const task = {
  id: 'task-1', kind: 'work', completionPolicy: 'reply', title: 'Task', project: 'project',
  instruction: 'Do work', targetRole: 'worker', dependsOn: [], attemptIds: [],
};
const message = {
  id: 'message-1', project: 'project', fromRole: 'worker', target: { kind: 'project' },
  type: 'result', content: 'unchanged', attemptIds: [],
};

describe('WorkAuthority batch mutation', () => {
  it('atomically updates an owner and inserts its attempt in one revision', () => {
    const authority = harness();
    authority.upsert({ kind: 'task', expectedRevision: 0, ...transport(0, 'seed-task'), document: task }, 1);
    authority.upsert({ kind: 'message', expectedRevision: 1, ...transport(1, 'seed-message'), document: message }, 2);
    const input = {
      expectedRevision: 2,
      ...transport(2, 'batch-1'),
      mutations: [
        { kind: 'task' as const, document: { ...task, attemptIds: ['attempt-1'] } },
        { kind: 'attempt' as const, document: { attemptId: 'attempt-1', taskId: 'task-1', state: 'prepared' } },
      ],
    };

    expect(authority.batchUpsert(input, 3)).toEqual({ revision: 3 });
    expect(authority.batchUpsert(input, 4)).toEqual({ revision: 3 });
    expect(authority.snapshot()).toMatchObject({
      revision: 3,
      tasks: [{ id: 'task-1', attemptIds: ['attempt-1'] }],
      attempts: [{ attemptId: 'attempt-1', taskId: 'task-1' }],
      messages: [message],
    });
  });

  it('rolls back the entire batch when final ownership is invalid', () => {
    const authority = harness();
    authority.upsert({ kind: 'task', expectedRevision: 0, ...transport(0, 'seed-task'), document: task }, 1);
    expect(() => authority.batchUpsert({
      expectedRevision: 1,
      ...transport(1, 'broken-batch'),
      mutations: [
        { kind: 'task', document: { ...task, attemptIds: ['attempt-1'] } },
        { kind: 'attempt', document: { attemptId: 'attempt-1', taskId: 'missing-task', state: 'prepared' } },
      ],
    }, 2)).toThrow(/missing task/i);
    expect(authority.snapshot()).toEqual({ revision: 1, tasks: [task], attempts: [], messages: [] });
  });

  it('rejects duplicate mutations for one document', () => {
    const authority = harness();
    expect(() => authority.batchUpsert({
      expectedRevision: 0,
      ...transport(0, 'duplicate-batch'),
      mutations: [
        { kind: 'task', document: task },
        { kind: 'task', document: { ...task, title: 'Other' } },
      ],
    }, 1)).toThrow(/duplicate batch mutation/i);
    expect(authority.snapshot().revision).toBe(0);
  });
});
