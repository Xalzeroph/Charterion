import { validateAgentMessage } from './messageBus';
import { normalizeTask } from './taskPolicy';
import { validateTaskGraph } from './taskGraph';
import type {
  AgentMessage,
  AgentMessageType,
  AgentTask,
  PortableManagerState,
  RoleBinding,
  PortableSendAttemptRecord,
  SendAttemptRecord,
} from './contracts';

const MAX_TASKS = 5000;
const MAX_ATTEMPTS = 20000;
const MAX_MESSAGES = 20000;
const MAX_BINDINGS = 5000;
const MAX_DOCUMENT_CHARS = 20_000_000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 10000): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a string <= ${max} chars`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function bindingValue(value: unknown, label: string): RoleBinding {
  const item = record(value);
  if (item.agentSlotId !== undefined) throw new Error(`${label}.agentSlotId is Kernel-local and not portable`);
  return {
    role: stringValue(item.role, `${label}.role`, 500),
    project: stringValue(item.project, `${label}.project`, 1000),
    notes: stringValue(item.notes, `${label}.notes`, 10000),
  };
}

function taskValue(value: unknown, index: number): AgentTask {
  const item = record(value);
  for (const key of ['id', 'kind', 'title', 'project', 'instruction', 'targetRole'] as const) {
    stringValue(item[key], `tasks[${index}].${key}`, key === 'instruction' ? 1_000_000 : 5000);
  }
  if (!Array.isArray(item.dependsOn) || !item.dependsOn.every((x) => typeof x === 'string')) {
    throw new Error(`tasks[${index}].dependsOn must be a string array`);
  }
  if (!Array.isArray(item.attemptIds) || !item.attemptIds.every((x) => typeof x === 'string')) {
    throw new Error(`tasks[${index}].attemptIds must be a string array`);
  }
  numberValue(item.createdAt, `tasks[${index}].createdAt`);
  numberValue(item.updatedAt, `tasks[${index}].updatedAt`);
  return normalizeTask(item as unknown as AgentTask);
}

const ATTEMPT_STATES = new Set(['prepared', 'dispatched', 'acknowledged', 'reply-observed', 'failed', 'uncertain']);

function attemptValue(value: unknown, index: number): PortableSendAttemptRecord {
  const item = record(value);
  if (item.contentEpoch !== undefined) throw new Error(`attempts[${index}].contentEpoch is runtime-local and not portable`);
  for (const key of ['attemptId', 'batchId', 'conversationKey', 'state'] as const) {
    stringValue(item[key], `attempts[${index}].${key}`, 2000);
  }
  for (const key of ['tabId', 'textLength', 'baselineAssistantMessageCount', 'createdAt', 'updatedAt'] as const) {
    numberValue(item[key], `attempts[${index}].${key}`);
  }
  if (!ATTEMPT_STATES.has(item.state as string)) throw new Error(`attempts[${index}].state is invalid`);
  if (item.retryOfAttemptId !== undefined) stringValue(item.retryOfAttemptId, `attempts[${index}].retryOfAttemptId`, 2000);
  return item as unknown as PortableSendAttemptRecord;
}

const MESSAGE_TYPES = new Set<AgentMessageType>([
  'result', 'blocker', 'question', 'answer', 'review-request', 'review-result', 'announcement',
]);

function messageValue(value: unknown, index: number): AgentMessage {
  const item = record(value);
  const id = stringValue(item.id, `messages[${index}].id`, 2000);
  const project = stringValue(item.project, `messages[${index}].project`, 5000);
  const fromRole = stringValue(item.fromRole, `messages[${index}].fromRole`, 5000);
  const type = stringValue(item.type, `messages[${index}].type`, 100) as AgentMessageType;
  if (!MESSAGE_TYPES.has(type)) throw new Error(`messages[${index}].type is invalid`);
  const content = stringValue(item.content, `messages[${index}].content`, 20000);
  const rawTarget = record(item.target);
  let target: AgentMessage['target'];
  if (rawTarget.kind === 'project') target = { kind: 'project' };
  else if (rawTarget.kind === 'role') target = { kind: 'role', role: stringValue(rawTarget.role, `messages[${index}].target.role`, 5000) };
  else throw new Error(`messages[${index}].target.kind is invalid`);
  if (!Array.isArray(item.attemptIds) || !item.attemptIds.every((x) => typeof x === 'string')) {
    throw new Error(`messages[${index}].attemptIds must be a string array`);
  }
  const message: AgentMessage = {
    id, project, fromRole, target, type, content,
    attemptIds: [...item.attemptIds] as string[],
    createdAt: numberValue(item.createdAt, `messages[${index}].createdAt`),
    updatedAt: numberValue(item.updatedAt, `messages[${index}].updatedAt`),
  };
  if (item.taskId !== undefined) message.taskId = stringValue(item.taskId, `messages[${index}].taskId`, 2000);
  if (item.recipientConversationKeys !== undefined) {
    if (!Array.isArray(item.recipientConversationKeys) || !item.recipientConversationKeys.every((x) => typeof x === 'string')) {
      throw new Error(`messages[${index}].recipientConversationKeys must be a string array`);
    }
    message.recipientConversationKeys = [...item.recipientConversationKeys] as string[];
  }
  validateAgentMessage(message);
  return message;
}

export function createPortableManagerState(
  bindings: Record<string, RoleBinding>,
  tasks: readonly AgentTask[],
  attempts: readonly SendAttemptRecord[],
  messages: readonly AgentMessage[],
  supervisorEnabled: boolean,
  now = Date.now(),
): PortableManagerState {
  return {
    schemaVersion: 3,
    exportedAt: now,
    bindings: Object.fromEntries(Object.entries(bindings).map(([key, binding]) => [key, { role: binding.role, project: binding.project, notes: binding.notes }])),
    tasks: structuredClone([...tasks]),
    attempts: attempts.map((attempt) => {
      const { contentEpoch: _runtimeEpoch, ...portable } = structuredClone(attempt);
      return portable;
    }),
    messages: structuredClone([...messages]),
    supervisorEnabled,
  };
}

export function parsePortableManagerState(document: string): PortableManagerState {
  if (document.length > MAX_DOCUMENT_CHARS) throw new Error('State document is too large');
  let parsed: unknown;
  try { parsed = JSON.parse(document); } catch { throw new Error('State document is not valid JSON'); }
  const root = record(parsed);
  if (root.schemaVersion !== 3) throw new Error('Unsupported state schemaVersion');
  const exportedAt = numberValue(root.exportedAt, 'exportedAt');
  if (typeof root.supervisorEnabled !== 'boolean') throw new Error('supervisorEnabled must be boolean');
  const rawBindings = record(root.bindings);
  const bindingEntries = Object.entries(rawBindings);
  if (bindingEntries.length > MAX_BINDINGS) throw new Error(`Too many bindings; maximum ${MAX_BINDINGS}`);
  const bindings: Record<string, RoleBinding> = {};
  for (const [key, value] of bindingEntries) bindings[key] = bindingValue(value, `bindings.${key}`);
  if (!Array.isArray(root.tasks) || root.tasks.length > MAX_TASKS) throw new Error(`tasks must contain <= ${MAX_TASKS} items`);
  if (!Array.isArray(root.attempts) || root.attempts.length > MAX_ATTEMPTS) throw new Error(`attempts must contain <= ${MAX_ATTEMPTS} items`);
  const rawMessages = root.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length > MAX_MESSAGES) throw new Error(`messages must contain <= ${MAX_MESSAGES} items`);
  const tasks = root.tasks.map(taskValue);
  const attempts = root.attempts.map(attemptValue);
  const messages = rawMessages.map(messageValue);
  validateTaskGraph(tasks);

  const attemptIds = new Set<string>();
  const attemptsById = new Map<string, PortableSendAttemptRecord>();
  for (const attempt of attempts) {
    if (attemptIds.has(attempt.attemptId)) throw new Error(`Duplicate attempt id ${attempt.attemptId}`);
    attemptIds.add(attempt.attemptId);
    attemptsById.set(attempt.attemptId, attempt);
  }
  for (const attempt of attempts) {
    if (!attempt.retryOfAttemptId) continue;
    const source = attemptsById.get(attempt.retryOfAttemptId);
    if (!source) throw new Error(`Attempt ${attempt.attemptId} retries missing attempt ${attempt.retryOfAttemptId}`);
    if (source.attemptId === attempt.attemptId) throw new Error(`Attempt ${attempt.attemptId} cannot retry itself`);
    if (source.taskId !== attempt.taskId || source.messageId !== attempt.messageId) {
      throw new Error(`Attempt ${attempt.attemptId} retry lineage crosses ownership`);
    }
    if (source.createdAt > attempt.createdAt) throw new Error(`Attempt ${attempt.attemptId} retry lineage points forward in time`);
  }

  const tasksById = new Map<string, AgentTask>();
  for (const task of tasks) tasksById.set(task.id, task);
  for (const task of tasks) {
    for (const attemptId of task.attemptIds) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) throw new Error(`Task ${task.id} references missing attempt ${attemptId}`);
      if (attempt.taskId !== task.id || attempt.messageId) {
        throw new Error(`Task ${task.id} references attempt ${attemptId} with inconsistent ownership`);
      }
    }
  }

  const messagesById = new Map<string, AgentMessage>();
  const recipientSets = new Map<string, Set<string>>();
  for (const message of messages) {
    if (messagesById.has(message.id)) throw new Error(`Duplicate message id ${message.id}`);
    messagesById.set(message.id, message);
    if (message.recipientConversationKeys) recipientSets.set(message.id, new Set(message.recipientConversationKeys));
    if (message.taskId && !tasksById.has(message.taskId)) throw new Error(`Message ${message.id} references missing task ${message.taskId}`);
    for (const attemptId of message.attemptIds) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) throw new Error(`Message ${message.id} references missing attempt ${attemptId}`);
      if (attempt.messageId !== message.id || attempt.taskId) {
        throw new Error(`Message ${message.id} references attempt ${attemptId} with inconsistent ownership`);
      }
      if (message.recipientConversationKeys && !recipientSets.get(message.id)!.has(attempt.conversationKey)) {
        throw new Error(`Message ${message.id} attempt ${attemptId} is outside its frozen recipient set`);
      }
    }
  }

  for (const attempt of attempts) {
    if (attempt.taskId && attempt.messageId) throw new Error(`Attempt ${attempt.attemptId} cannot belong to both a task and a message`);
    if (attempt.taskId) {
      const owner = tasksById.get(attempt.taskId);
      if (!owner) throw new Error(`Attempt ${attempt.attemptId} references missing task ${attempt.taskId}`);
      if (!owner.attemptIds.includes(attempt.attemptId)) throw new Error(`Attempt ${attempt.attemptId} is not referenced by owning task ${attempt.taskId}`);
    }
    if (attempt.messageId) {
      const owner = messagesById.get(attempt.messageId);
      if (!owner) throw new Error(`Attempt ${attempt.attemptId} references missing message ${attempt.messageId}`);
      if (!owner.attemptIds.includes(attempt.attemptId)) throw new Error(`Attempt ${attempt.attemptId} is not referenced by owning message ${attempt.messageId}`);
    }
  }
  return {
    schemaVersion: 3,
    exportedAt,
    bindings,
    tasks,
    attempts,
    messages,
    supervisorEnabled: root.supervisorEnabled,
  };
}

export function restorePortableAttempts(attempts: readonly PortableSendAttemptRecord[]): SendAttemptRecord[] {
  return attempts.map((attempt) => {
    const restored: SendAttemptRecord = {
      ...structuredClone(attempt),
      contentEpoch: `portable-detached:${attempt.attemptId}`,
    };
    if (attempt.state === 'prepared') {
      restored.state = 'failed';
      restored.error = 'Portable state detached before browser dispatch; prompt was not sent';
    } else if (attempt.state === 'dispatched' || attempt.state === 'acknowledged') {
      restored.state = 'uncertain';
      restored.error = 'Portable state omitted browser runtime identity; prior delivery cannot be reconstructed safely';
    }
    return restored;
  });
}

export function stringifyPortableManagerState(state: PortableManagerState): string {
  return JSON.stringify(state, null, 2);
}
