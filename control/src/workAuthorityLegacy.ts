import { createHash } from 'node:crypto';
import type { ControlDatabase } from './database';
import type { VerifiedTaskCompletion } from './contracts';

type WorkDocument = Record<string, unknown>;
type WorkKind = 'task' | 'attempt' | 'message';

const ID_FIELD: Record<WorkKind, 'id' | 'attemptId'> = { task: 'id', attempt: 'attemptId', message: 'id' };

function workId(item: WorkDocument, kind: WorkKind): string {
  const field = ID_FIELD[kind];
  const value = item[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${kind}.${field} is required`);
  return value;
}

export interface KernelWorkSnapshot {
  revision: number;
  tasks: WorkDocument[];
  attempts: WorkDocument[];
  messages: WorkDocument[];
}

export interface ReplaceKernelWorkInput {
  expectedRevision: number;
  transportGeneration: string;
  transportSequence: number;
  transportMessageId: string;
  tasks: WorkDocument[];
  attempts: WorkDocument[];
  messages: WorkDocument[];
}

export interface UpsertKernelWorkInput {
  kind: WorkKind;
  expectedRevision: number;
  transportGeneration: string;
  transportSequence: number;
  transportMessageId: string;
  document: WorkDocument;
}

function document(value: unknown, label: string): WorkDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const copy = JSON.parse(JSON.stringify(value)) as WorkDocument;
  return copy;
}

function stringIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function uniqueDocuments(values: unknown[], kind: WorkKind): WorkDocument[] {
  const result = values.map((value, index) => document(value, `${kind}s[${index}]`));
  const seen = new Set<string>();
  for (const item of result) {
    const id = workId(item, kind);
    if (seen.has(id)) throw new Error(`Duplicate ${kind} id ${id}`);
    seen.add(id);
  }
  return result;
}

function validateState(input: ReplaceKernelWorkInput): ReplaceKernelWorkInput {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('expectedRevision is invalid');
  if (!input.transportGeneration.trim() || !input.transportMessageId.trim()) throw new Error('Work transport identity is required');
  if (!Number.isInteger(input.transportSequence) || input.transportSequence !== input.expectedRevision + 1) throw new Error('Work transport sequence must equal expectedRevision + 1');
  const tasks = uniqueDocuments(input.tasks, 'task');
  const attempts = uniqueDocuments(input.attempts, 'attempt');
  const messages = uniqueDocuments(input.messages, 'message');
  const taskIds = new Set(tasks.map((item) => workId(item, 'task')));
  const attemptIds = new Set(attempts.map((item) => workId(item, 'attempt')));
  const messageIds = new Set(messages.map((item) => workId(item, 'message')));
  const attemptsById = new Map(attempts.map((item) => [workId(item, 'attempt'), item]));

  for (const attempt of attempts) {
    const taskId = typeof attempt.taskId === 'string' ? attempt.taskId : undefined;
    const messageId = typeof attempt.messageId === 'string' ? attempt.messageId : undefined;
    if (taskId && messageId) throw new Error(`Attempt ${workId(attempt, 'attempt')} cannot belong to both task and message`);
    if (taskId && !taskIds.has(taskId)) throw new Error(`Attempt ${workId(attempt, 'attempt')} references missing task ${taskId}`);
    if (messageId && !messageIds.has(messageId)) throw new Error(`Attempt ${workId(attempt, 'attempt')} references missing message ${messageId}`);
  }

  for (const task of tasks) {
    for (const attemptId of stringIds(task.attemptIds ?? [], `task ${task.id}.attemptIds`)) {
      if (!attemptIds.has(attemptId)) throw new Error(`Task ${workId(task, 'task')} references missing attempt ${attemptId}`);
      const attempt = attemptsById.get(attemptId)!;
      if (attempt.taskId !== workId(task, 'task')) throw new Error(`Task ${workId(task, 'task')} does not own attempt ${attemptId}`);
    }
  }
  for (const message of messages) {
    for (const attemptId of stringIds(message.attemptIds ?? [], `message ${message.id}.attemptIds`)) {
      if (!attemptIds.has(attemptId)) throw new Error(`Message ${workId(message, 'message')} references missing attempt ${attemptId}`);
      const attempt = attemptsById.get(attemptId)!;
      if (attempt.messageId !== workId(message, 'message')) throw new Error(`Message ${workId(message, 'message')} does not own attempt ${attemptId}`);
    }
  }
  return { expectedRevision: input.expectedRevision, transportGeneration: input.transportGeneration, transportSequence: input.transportSequence, transportMessageId: input.transportMessageId, tasks, attempts, messages };
}

function rows(database: ControlDatabase, table: string): WorkDocument[] {
  return (database.db.prepare(`SELECT document_json FROM ${table} ORDER BY position`).all() as { document_json: string }[])
    .map((row) => JSON.parse(row.document_json) as WorkDocument);
}

export class WorkAuthority {
  constructor(private readonly database: ControlDatabase) {}

  snapshot(): KernelWorkSnapshot {
    const row = this.database.db.prepare('SELECT revision FROM manager_work_meta WHERE singleton=1').get() as { revision: number };
    return {
      revision: Number(row.revision),
      tasks: rows(this.database, 'manager_tasks'),
      attempts: rows(this.database, 'manager_attempts'),
      messages: rows(this.database, 'manager_messages'),
    };
  }

  getTask(taskId: string): WorkDocument | undefined {
    const row = this.database.db.prepare('SELECT document_json FROM manager_tasks WHERE id=?').get(taskId.trim()) as { document_json?: string } | undefined;
    return row?.document_json ? document(JSON.parse(row.document_json), `task ${taskId}`) : undefined;
  }

  taskCompletionPolicy(taskId: string): string | undefined {
    const row = this.database.db.prepare('SELECT document_json FROM manager_tasks WHERE id=?').get(taskId.trim()) as { document_json?: string } | undefined;
    if (!row?.document_json) return undefined;
    const task = JSON.parse(row.document_json) as WorkDocument;
    return typeof task.completionPolicy === 'string' ? task.completionPolicy : undefined;
  }

  appendTask(input: Record<string, unknown>, now = Date.now()): WorkDocument {
    const task = document(input, 'task');
    const id = workId(task, 'task');
    if (task.kind !== 'work') throw new Error('Appended execution task must be work kind');
    if (!['reply', 'structured-result', 'verified-claim'].includes(String(task.completionPolicy))) {
      throw new Error('Appended execution task has an unsupported completion policy');
    }
    const dependsOn = stringIds(task.dependsOn ?? [], `task ${id}.dependsOn`);
    stringIds(task.attemptIds ?? [], `task ${id}.attemptIds`);
    return this.database.transaction(() => {
      const existing = this.getTask(id);
      if (existing) {
        const identity = ['kind','completionPolicy','project','targetRole','organizationId','organizationAgentId','missionId','organizationWorkItemId','projectId'];
        if (identity.some((key) => existing[key] !== task[key])) throw new Error(`Task ${id} already exists with a different execution identity`);
        return existing;
      }
      for (const dependencyId of dependsOn) {
        if (!this.getTask(dependencyId)) throw new Error(`Task ${id} references missing dependency ${dependencyId}`);
      }
      const count = this.database.db.prepare('SELECT COUNT(*) AS count FROM manager_tasks').get() as { count: number };
      this.database.db.prepare('INSERT INTO manager_tasks(id,position,document_json,updated_at) VALUES(?,?,?,?)')
        .run(id, Number(count.count), JSON.stringify(task), now);
      const meta = this.database.db.prepare('SELECT revision FROM manager_work_meta WHERE singleton=1').get() as { revision: number };
      const revision = Number(meta.revision) + 1;
      this.database.db.prepare('UPDATE manager_work_meta SET revision=?,updated_at=? WHERE singleton=1').run(revision, now);
      this.database.db.prepare(`INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(NULL,'WORK_TASK_APPENDED',?,?,?)`)
        .run(id, JSON.stringify({ revision, source: 'organization-execution' }), now);
      return this.getTask(id)!;
    });
  }

  upsert(input: UpsertKernelWorkInput, now = Date.now()): { revision: number } {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('expectedRevision is invalid');
    if (!input.transportGeneration.trim() || !input.transportMessageId.trim()) throw new Error('Work transport identity is required');
    if (!Number.isInteger(input.transportSequence) || input.transportSequence !== input.expectedRevision + 1) throw new Error('Work transport sequence must equal expectedRevision + 1');
    const item = document(input.document, input.kind + ' document');
    const id = workId(item, input.kind);
    if (input.kind === 'task') {
      stringIds(item.attemptIds ?? [], `task ${id}.attemptIds`);
      stringIds(item.dependsOn ?? [], `task ${id}.dependsOn`);
      for (const key of ['kind', 'completionPolicy', 'title', 'project', 'instruction', 'targetRole']) if (typeof item[key] !== 'string') throw new Error(`task ${id}.${key} is required`);
    } else if (input.kind === 'message') {
      stringIds(item.attemptIds ?? [], `message ${id}.attemptIds`);
      document(item.target, `message ${id}.target`);
      for (const key of ['project', 'fromRole', 'type', 'content']) if (typeof item[key] !== 'string') throw new Error(`message ${id}.${key} is required`);
    }
    const table = input.kind === 'task' ? 'manager_tasks' : input.kind === 'attempt' ? 'manager_attempts' : 'manager_messages';
    const payloadHash = createHash('sha256').update(JSON.stringify({ kind: input.kind, expectedRevision: input.expectedRevision, document: item })).digest('hex');
    return this.database.transaction(() => {
      const receipt = this.database.db.prepare('SELECT generation,sequence,payload_hash,result_revision FROM manager_work_mutations WHERE message_id=?').get(input.transportMessageId) as { generation?: string; sequence?: number; payload_hash?: string; result_revision?: number } | undefined;
      if (receipt) {
        if (receipt.generation !== input.transportGeneration || Number(receipt.sequence) !== input.transportSequence || receipt.payload_hash !== payloadHash) throw new Error('Work transport message identity conflict');
        return { revision: Number(receipt.result_revision) };
      }
      const sequenceConflict = this.database.db.prepare('SELECT message_id FROM manager_work_mutations WHERE generation=? AND sequence=?').get(input.transportGeneration, input.transportSequence) as { message_id?: string } | undefined;
      if (sequenceConflict?.message_id) throw new Error('Work transport sequence is already occupied by another message');
      const current = this.database.db.prepare('SELECT revision FROM manager_work_meta WHERE singleton=1').get() as { revision: number };
      if (Number(current.revision) !== input.expectedRevision) throw new Error(`Work state revision conflict: expected ${input.expectedRevision}, current ${current.revision}`);
      if (input.kind === 'attempt') {
        const taskId = typeof item.taskId === 'string' ? item.taskId : undefined;
        const messageId = typeof item.messageId === 'string' ? item.messageId : undefined;
        if (taskId && messageId) throw new Error(`Attempt ${id} cannot belong to both task and message`);
        if (taskId && !this.getTask(taskId)) throw new Error(`Attempt ${id} references missing task ${taskId}`);
        if (messageId && !this.database.db.prepare('SELECT id FROM manager_messages WHERE id=?').get(messageId)) throw new Error(`Attempt ${id} references missing message ${messageId}`);
      }
      const existing = this.database.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id);
      if (existing) {
        this.database.db.prepare(`UPDATE ${table} SET document_json=?,updated_at=? WHERE id=?`).run(JSON.stringify(item), now, id);
      } else {
        const count = this.database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        this.database.db.prepare(`INSERT INTO ${table}(id,position,document_json,updated_at) VALUES(?,?,?,?)`).run(id, Number(count.count), JSON.stringify(item), now);
      }
      const revision = input.expectedRevision + 1;
      this.database.db.prepare('UPDATE manager_work_meta SET revision=?,updated_at=? WHERE singleton=1').run(revision, now);
      this.database.db.prepare('INSERT INTO manager_work_mutations(message_id,generation,sequence,payload_hash,result_revision,created_at) VALUES(?,?,?,?,?,?)')
        .run(input.transportMessageId, input.transportGeneration, input.transportSequence, payloadHash, revision, now);
      this.database.db.prepare(`INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(NULL,'WORK_DOCUMENT_UPSERTED',?,?,?)`)
        .run(id, JSON.stringify({ kind: input.kind, revision }), now);
      return { revision };
    });
  }

  completeVerifiedClaim(input: { taskId: string; claimId: string; verificationId: string; commitSha?: string }, now = Date.now()): KernelWorkSnapshot {
    const taskId = input.taskId.trim();
    const claimId = input.claimId.trim();
    const verificationId = input.verificationId.trim();
    if (!taskId || !claimId || !verificationId) throw new Error('Verified task completion identity is required');
    return this.database.transaction(() => {
      const row = this.database.db.prepare('SELECT document_json FROM manager_tasks WHERE id=?').get(taskId) as { document_json?: string } | undefined;
      if (!row?.document_json) throw new Error(`Task ${taskId} does not exist in Kernel work state`);
      const task = JSON.parse(row.document_json) as WorkDocument;
      if (task.completionPolicy !== 'verified-claim') throw new Error(`Task ${taskId} does not accept verified-claim completion`);
      const existing = task.machineCompletion as VerifiedTaskCompletion | undefined;
      const commitSha = input.commitSha?.trim() || undefined;
      if (existing) {
        if (existing.kind !== 'verified-claim' || existing.claimId !== claimId || existing.verificationId !== verificationId || existing.commitSha !== commitSha) {
          throw new Error(`Task ${taskId} already has a different machine completion`);
        }
        return this.snapshot();
      }
      const completion: VerifiedTaskCompletion = { kind: 'verified-claim', claimId, verificationId, completedAt: now, ...(commitSha ? { commitSha } : {}) };
      task.machineCompletion = completion;
      task.updatedAt = now;
      this.database.db.prepare('UPDATE manager_tasks SET document_json=?,updated_at=? WHERE id=?').run(JSON.stringify(task), now, taskId);
      const current = this.database.db.prepare('SELECT revision FROM manager_work_meta WHERE singleton=1').get() as { revision: number };
      const revision = Number(current.revision) + 1;
      this.database.db.prepare('UPDATE manager_work_meta SET revision=?,updated_at=? WHERE singleton=1').run(revision, now);
      this.database.db.prepare(`INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(NULL,'WORK_TASK_MACHINE_COMPLETED',?,?,?)`)
        .run(taskId, JSON.stringify(completion), now);
      return this.snapshot();
    });
  }
  replace(input: ReplaceKernelWorkInput, now = Date.now()): KernelWorkSnapshot {
    const state = validateState(input);
    return this.database.transaction(() => {
      const payloadHash = createHash('sha256').update(JSON.stringify({ expectedRevision: state.expectedRevision, tasks: state.tasks, attempts: state.attempts, messages: state.messages })).digest('hex');
      const receipt = this.database.db.prepare('SELECT * FROM manager_work_mutations WHERE message_id=?').get(state.transportMessageId) as { generation: string; sequence: number; payload_hash: string; result_revision: number } | undefined;
      if (receipt) {
        if (receipt.generation !== state.transportGeneration || Number(receipt.sequence) !== state.transportSequence || receipt.payload_hash !== payloadHash) throw new Error('Work transport message identity conflict');
        return this.snapshot();
      }
      const sequenceConflict = this.database.db.prepare('SELECT message_id FROM manager_work_mutations WHERE generation=? AND sequence=?').get(state.transportGeneration, state.transportSequence) as { message_id?: string } | undefined;
      if (sequenceConflict?.message_id) throw new Error('Work transport sequence is already occupied by another message');
      const current = this.snapshot();
      if (current.revision !== state.expectedRevision) {
        throw new Error(`Work state revision conflict: expected ${state.expectedRevision}, current ${current.revision}`);
      }
      this.database.db.exec('DELETE FROM manager_tasks; DELETE FROM manager_attempts; DELETE FROM manager_messages;');
      const insert = (table: string, kind: WorkKind, documents: WorkDocument[]) => {
        const statement = this.database.db.prepare(`INSERT INTO ${table}(id,position,document_json,updated_at) VALUES(?,?,?,?)`);
        documents.forEach((item, index) => statement.run(workId(item, kind), index, JSON.stringify(item), now));
      };
      insert('manager_tasks', 'task', state.tasks);
      insert('manager_attempts', 'attempt', state.attempts);
      insert('manager_messages', 'message', state.messages);
      const revision = current.revision + 1;
      this.database.db.prepare('UPDATE manager_work_meta SET revision=?,updated_at=? WHERE singleton=1').run(revision, now);
      this.database.db.prepare('INSERT INTO manager_work_mutations(message_id,generation,sequence,payload_hash,result_revision,created_at) VALUES(?,?,?,?,?,?)')
        .run(state.transportMessageId, state.transportGeneration, state.transportSequence, payloadHash, revision, now);
      this.database.db.prepare(`INSERT INTO events(project_id,type,subject,payload_json,created_at) VALUES(NULL,'WORK_STATE_REPLACED','browser-manager',?,?)`)
        .run(JSON.stringify({ revision, tasks: state.tasks.length, attempts: state.attempts.length, messages: state.messages.length }), now);
      return this.snapshot();
    });
  }
}
