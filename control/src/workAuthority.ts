import { createHash } from 'node:crypto';
import type { ControlDatabase } from './database';
import { WorkAuthority as LegacyWorkAuthority, type KernelWorkSnapshot } from './workAuthorityLegacy';

export * from './workAuthorityLegacy';

type WorkDocument = Record<string, unknown>;
export type BatchWorkKind = 'task' | 'attempt' | 'message';

export interface BatchWorkMutation {
  kind: BatchWorkKind;
  document: WorkDocument;
}

export interface BatchUpsertKernelWorkInput {
  expectedRevision: number;
  transportGeneration: string;
  transportSequence: number;
  transportMessageId: string;
  mutations: BatchWorkMutation[];
}

const ID_FIELD: Record<BatchWorkKind, 'id' | 'attemptId'> = {
  task: 'id',
  attempt: 'attemptId',
  message: 'id',
};

const TABLE: Record<BatchWorkKind, string> = {
  task: 'manager_tasks',
  attempt: 'manager_attempts',
  message: 'manager_messages',
};

function document(value: unknown, label: string): WorkDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return JSON.parse(JSON.stringify(value)) as WorkDocument;
}

function workId(item: WorkDocument, kind: BatchWorkKind): string {
  const field = ID_FIELD[kind];
  const value = item[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${kind}.${field} is required`);
  return value;
}

function stringIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function validateMutationShape(kind: BatchWorkKind, item: WorkDocument): void {
  const id = workId(item, kind);
  if (kind === 'task') {
    stringIds(item.attemptIds ?? [], `task ${id}.attemptIds`);
    stringIds(item.dependsOn ?? [], `task ${id}.dependsOn`);
    for (const key of ['kind', 'completionPolicy', 'title', 'project', 'instruction', 'targetRole']) {
      if (typeof item[key] !== 'string') throw new Error(`task ${id}.${key} is required`);
    }
  } else if (kind === 'message') {
    stringIds(item.attemptIds ?? [], `message ${id}.attemptIds`);
    document(item.target, `message ${id}.target`);
    for (const key of ['project', 'fromRole', 'type', 'content']) {
      if (typeof item[key] !== 'string') throw new Error(`message ${id}.${key} is required`);
    }
  }
}

function indexedDocuments(items: WorkDocument[], kind: BatchWorkKind): Map<string, number> {
  const result = new Map<string, number>();
  items.forEach((item, index) => {
    const id = workId(item, kind);
    if (result.has(id)) throw new Error(`Duplicate ${kind} id ${id}`);
    result.set(id, index);
  });
  return result;
}

function applyBatch(current: KernelWorkSnapshot, mutations: readonly BatchWorkMutation[]): KernelWorkSnapshot {
  const tasks = current.tasks.map((item) => document(item, 'task'));
  const attempts = current.attempts.map((item) => document(item, 'attempt'));
  const messages = current.messages.map((item) => document(item, 'message'));
  const arrays: Record<BatchWorkKind, WorkDocument[]> = { task: tasks, attempt: attempts, message: messages };
  const indexes: Record<BatchWorkKind, Map<string, number>> = {
    task: indexedDocuments(tasks, 'task'),
    attempt: indexedDocuments(attempts, 'attempt'),
    message: indexedDocuments(messages, 'message'),
  };

  const seen = new Set<string>();
  for (const mutation of mutations) {
    const item = document(mutation.document, `${mutation.kind} document`);
    validateMutationShape(mutation.kind, item);
    const id = workId(item, mutation.kind);
    const mutationKey = `${mutation.kind}\u0000${id}`;
    if (seen.has(mutationKey)) throw new Error(`Duplicate batch mutation for ${mutation.kind} ${id}`);
    seen.add(mutationKey);
    const index = indexes[mutation.kind].get(id);
    if (index === undefined) {
      indexes[mutation.kind].set(id, arrays[mutation.kind].length);
      arrays[mutation.kind].push(item);
    } else {
      arrays[mutation.kind][index] = item;
    }
  }

  const taskIds = new Set(tasks.map((item) => workId(item, 'task')));
  const messageIds = new Set(messages.map((item) => workId(item, 'message')));
  const attemptsById = new Map(attempts.map((item) => [workId(item, 'attempt'), item]));

  for (const attempt of attempts) {
    const id = workId(attempt, 'attempt');
    const taskId = typeof attempt.taskId === 'string' ? attempt.taskId : undefined;
    const messageId = typeof attempt.messageId === 'string' ? attempt.messageId : undefined;
    if (taskId && messageId) throw new Error(`Attempt ${id} cannot belong to both task and message`);
    if (taskId && !taskIds.has(taskId)) throw new Error(`Attempt ${id} references missing task ${taskId}`);
    if (messageId && !messageIds.has(messageId)) throw new Error(`Attempt ${id} references missing message ${messageId}`);
  }
  for (const task of tasks) {
    const taskId = workId(task, 'task');
    for (const attemptId of stringIds(task.attemptIds ?? [], `task ${taskId}.attemptIds`)) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) throw new Error(`Task ${taskId} references missing attempt ${attemptId}`);
      if (attempt.taskId !== taskId) throw new Error(`Task ${taskId} does not own attempt ${attemptId}`);
    }
  }
  for (const message of messages) {
    const messageId = workId(message, 'message');
    for (const attemptId of stringIds(message.attemptIds ?? [], `message ${messageId}.attemptIds`)) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) throw new Error(`Message ${messageId} references missing attempt ${attemptId}`);
      if (attempt.messageId !== messageId) throw new Error(`Message ${messageId} does not own attempt ${attemptId}`);
    }
  }
  return { revision: current.revision, tasks, attempts, messages };
}

function normalizeBatch(input: BatchUpsertKernelWorkInput): BatchUpsertKernelWorkInput {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('expectedRevision is invalid');
  if (!input.transportGeneration.trim() || !input.transportMessageId.trim()) throw new Error('Work transport identity is required');
  if (!Number.isInteger(input.transportSequence) || input.transportSequence !== input.expectedRevision + 1) {
    throw new Error('Work transport sequence must equal expectedRevision + 1');
  }
  if (!Array.isArray(input.mutations) || input.mutations.length === 0 || input.mutations.length > 32) {
    throw new Error('Work batch mutations must contain between 1 and 32 documents');
  }
  const mutations = input.mutations.map((mutation, index) => {
    if (!mutation || !['task', 'attempt', 'message'].includes(mutation.kind)) {
      throw new Error(`mutations[${index}].kind is invalid`);
    }
    return { kind: mutation.kind, document: document(mutation.document, `mutations[${index}].document`) };
  });
  return { ...input, mutations };
}

export class WorkAuthority extends LegacyWorkAuthority {
  constructor(private readonly batchDatabase: ControlDatabase) {
    super(batchDatabase);
  }

  batchUpsert(input: BatchUpsertKernelWorkInput, now = Date.now()): { revision: number } {
    const batch = normalizeBatch(input);
    const payloadHash = createHash('sha256').update(JSON.stringify({
      expectedRevision: batch.expectedRevision,
      mutations: batch.mutations,
    })).digest('hex');

    return this.batchDatabase.transaction(() => {
      const receipt = this.batchDatabase.db.prepare(
        'SELECT generation,sequence,payload_hash,result_revision FROM manager_work_mutations WHERE message_id=?',
      ).get(batch.transportMessageId) as { generation?: string; sequence?: number; payload_hash?: string; result_revision?: number } | undefined;
      if (receipt) {
        if (receipt.generation !== batch.transportGeneration || Number(receipt.sequence) !== batch.transportSequence || receipt.payload_hash !== payloadHash) {
          throw new Error('Work transport message identity conflict');
        }
        return { revision: Number(receipt.result_revision) };
      }
      const sequenceConflict = this.batchDatabase.db.prepare(
        'SELECT message_id FROM manager_work_mutations WHERE generation=? AND sequence=?',
      ).get(batch.transportGeneration, batch.transportSequence) as { message_id?: string } | undefined;
      if (sequenceConflict?.message_id) throw new Error('Work transport sequence is already occupied by another message');

      const current = this.snapshot();
      if (current.revision !== batch.expectedRevision) {
        throw new Error(`Work state revision conflict: expected ${batch.expectedRevision}, current ${current.revision}`);
      }
      applyBatch(current, batch.mutations);

      for (const mutation of batch.mutations) {
        const item = document(mutation.document, `${mutation.kind} document`);
        const id = workId(item, mutation.kind);
        const table = TABLE[mutation.kind];
        const existing = this.batchDatabase.db.prepare(`SELECT position FROM ${table} WHERE id=?`).get(id) as { position?: number } | undefined;
        if (existing) {
          this.batchDatabase.db.prepare(`UPDATE ${table} SET document_json=?,updated_at=? WHERE id=?`).run(JSON.stringify(item), now, id);
        } else {
          const count = this.batchDatabase.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
          this.batchDatabase.db.prepare(`INSERT INTO ${table}(id,position,document_json,updated_at) VALUES(?,?,?,?)`)
            .run(id, Number(count.count), JSON.stringify(item), now);
        }
      }

      const revision = batch.expectedRevision + 1;
      this.batchDatabase.db.prepare('UPDATE manager_work_meta SET revision=?,updated_at=? WHERE singleton=1').run(revision, now);
      this.batchDatabase.db.prepare(
        'INSERT INTO manager_work_mutations(message_id,generation,sequence,payload_hash,result_revision,created_at) VALUES(?,?,?,?,?,?)',
      ).run(batch.transportMessageId, batch.transportGeneration, batch.transportSequence, payloadHash, revision, now);
      this.batchDatabase.db.prepare(
        `INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(NULL,'WORK_DOCUMENTS_BATCH_UPSERTED','browser-manager',?,?)`,
      ).run(JSON.stringify({ revision, mutations: batch.mutations.length }), now);
      return { revision };
    });
  }
}
