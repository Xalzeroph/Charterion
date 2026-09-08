import { nativeResult, parseNativeRpcResponse, type NativeRpcResponse } from './nativeRpcContract';
import { sendPersistentNativeMessage } from './nativeMessageTransport';
import { NATIVE_CONTROL_HOST, assertNativeRpcMethod, type NativeRpcMethod } from './nativeRpcProtocol.generated';
import {
  parseNativeControlSnapshot,
  parseNativeTaskWorkspace,
  type AgentBrowserReportInput,
  type AgentRuntimeReportInput,
  type BrowserRuntimeReportInput,
  type NativeControlSnapshot,
  type NativeOrganizationExecutionProjection,
  type NativeRolloverStatus,
  type NativeTaskWorkspace,
  type NativeWorkSnapshot,
} from './nativeControlLegacy';

const WORK_TRANSPORT_KEY = 'nativeWorkTransport.v1';
const ROLLOVER_STATUSES = new Set(['requested', 'opening', 'bootstrapping']);

export interface NativeWorkDocumentMutation {
  kind: 'task' | 'attempt' | 'message';
  document: Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a number`);
  return value;
}

function enumField(value: unknown, label: string, allowed: ReadonlySet<string>): string {
  const text = stringField(value, label);
  if (!allowed.has(text)) throw new Error(`${label} is invalid`);
  return text;
}

function arrayField(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringArrayField(value: unknown, label: string): string[] {
  const array = arrayField(value, label);
  if (!array.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return array as string[];
}

function unavailable(error: unknown): Error {
  return new Error(`Native control plane is unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

async function persistentNativeResult(method: NativeRpcMethod, params: Record<string, unknown>): Promise<unknown> {
  assertNativeRpcMethod(method);
  const request = { id: crypto.randomUUID(), method, params };
  let response: NativeRpcResponse;
  try {
    response = parseNativeRpcResponse(await sendPersistentNativeMessage(NATIVE_CONTROL_HOST, request));
  } catch (error) {
    throw unavailable(error);
  }
  return nativeResult(response, request.id, method);
}

function parseNativeWorkSnapshot(value: unknown): NativeWorkSnapshot {
  const root = record(value, 'work snapshot');
  const parseDocuments = <T>(key: string, idField: 'id' | 'attemptId'): T[] => arrayField(root[key], key).map((entry, index) => {
    const item = record(entry, `${key}[${index}]`);
    stringField(item[idField], `${key}[${index}].${idField}`);
    if (key === 'tasks') {
      stringArrayField(item.attemptIds, `${key}[${index}].attemptIds`);
      stringArrayField(item.dependsOn, `${key}[${index}].dependsOn`);
      stringField(item.kind, `${key}[${index}].kind`);
      stringField(item.completionPolicy, `${key}[${index}].completionPolicy`);
    } else if (key === 'attempts') {
      stringField(item.state, `${key}[${index}].state`);
      numberField(item.tabId, `${key}[${index}].tabId`);
      numberField(item.createdAt, `${key}[${index}].createdAt`);
      numberField(item.updatedAt, `${key}[${index}].updatedAt`);
    } else {
      stringArrayField(item.attemptIds, `${key}[${index}].attemptIds`);
      record(item.target, `${key}[${index}].target`);
      stringField(item.type, `${key}[${index}].type`);
      stringField(item.content, `${key}[${index}].content`);
    }
    return item as T;
  });
  return {
    revision: numberField(root.revision, 'work.revision'),
    tasks: parseDocuments<import('./contracts').AgentTask>('tasks', 'id'),
    attempts: parseDocuments<import('./contracts').SendAttemptRecord>('attempts', 'attemptId'),
    messages: parseDocuments<import('./contracts').AgentMessage>('messages', 'id'),
  };
}

function parseRolloverStatus(value: unknown): NativeRolloverStatus | null {
  if (value === null) return null;
  const root = record(value, 'rollover status');
  const rollover = record(root.rollover, 'rollover');
  const checkpoint = record(root.checkpoint, 'checkpoint');
  const result: NativeRolloverStatus = {
    rollover: {
      id: stringField(rollover.id, 'rollover.id'),
      slotId: stringField(rollover.slotId, 'rollover.slotId'),
      status: enumField(rollover.status, 'rollover.status', ROLLOVER_STATUSES) as NativeRolloverStatus['rollover']['status'],
      checkpointId: stringField(rollover.checkpointId, 'rollover.checkpointId'),
      fromConversationKey: stringField(rollover.fromConversationKey, 'rollover.fromConversationKey'),
      reason: stringField(rollover.reason, 'rollover.reason'),
    },
    checkpoint: {
      id: stringField(checkpoint.id, 'checkpoint.id'),
      handoffText: stringField(checkpoint.handoffText, 'checkpoint.handoffText'),
      reason: stringField(checkpoint.reason, 'checkpoint.reason'),
      state: record(checkpoint.state, 'checkpoint.state'),
    },
  };
  if (rollover.toConversationKey !== undefined) result.rollover.toConversationKey = stringField(rollover.toConversationKey, 'rollover.toConversationKey');
  if (rollover.bootstrapAttemptId !== undefined) result.rollover.bootstrapAttemptId = stringField(rollover.bootstrapAttemptId, 'rollover.bootstrapAttemptId');
  return result;
}

function parseOrganizationExecutionProjection(value: unknown): NativeOrganizationExecutionProjection {
  const item = record(value, 'organization execution projection');
  const task = parseNativeWorkSnapshot({ revision: 0, tasks: [item.task], attempts: [], messages: [] }).tasks[0];
  if (!task) throw new Error('organization execution projection task is missing');
  return {
    workItemId: stringField(item.workItemId, 'projection.workItemId'),
    missionId: stringField(item.missionId, 'projection.missionId'),
    organizationAgentId: stringField(item.organizationAgentId, 'projection.organizationAgentId'),
    projectId: stringField(item.projectId, 'projection.projectId'),
    runtimeSlotId: stringField(item.runtimeSlotId, 'projection.runtimeSlotId'),
    managerTaskId: stringField(item.managerTaskId, 'projection.managerTaskId'),
    task,
  };
}

async function workTransportGeneration(): Promise<string> {
  const stored = await chrome.storage.session.get(WORK_TRANSPORT_KEY);
  const current = stored[WORK_TRANSPORT_KEY];
  if (typeof current === 'string' && current) return current;
  const generation = crypto.randomUUID();
  await chrome.storage.session.set({ [WORK_TRANSPORT_KEY]: generation });
  return generation;
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function workPayloadHash(input: NativeWorkSnapshot): Promise<string> {
  return sha256Json({ revision: input.revision, tasks: input.tasks, attempts: input.attempts, messages: input.messages });
}

async function sendRetriedWorkRequest(request: { id: string; method: NativeRpcMethod; params: Record<string, unknown> }): Promise<NativeRpcResponse> {
  assertNativeRpcMethod(request.method);
  let response: NativeRpcResponse | undefined;
  let transportError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = parseNativeRpcResponse(await sendPersistentNativeMessage(NATIVE_CONTROL_HOST, request));
      transportError = undefined;
      break;
    } catch (error) {
      transportError = error;
    }
  }
  if (transportError || !response) throw unavailable(transportError);
  return response;
}

export async function readNativeControlSnapshot(): Promise<NativeControlSnapshot> {
  return parseNativeControlSnapshot(await persistentNativeResult('control.snapshot', {}));
}

export async function reportNativeBrowserRuntime(input: BrowserRuntimeReportInput): Promise<void> {
  await persistentNativeResult('browser.report', input as unknown as Record<string, unknown>);
}

export async function reportNativeAgentBrowser(input: AgentBrowserReportInput): Promise<void> {
  await persistentNativeResult('agent.browser-report', input as unknown as Record<string, unknown>);
}

export async function requestNativeAgentRollover(input: { slotId: string; reason: string; handoffText: string; state: Record<string, unknown> }): Promise<void> {
  await persistentNativeResult('agent.rollover-request', input as unknown as Record<string, unknown>);
}

export async function beginNativeAgentRollover(slotId: string, rolloverId: string): Promise<void> {
  await persistentNativeResult('agent.rollover-begin', { slotId, rolloverId });
}

export async function markNativeAgentRolloverBootstrap(slotId: string, rolloverId: string, attemptId: string): Promise<void> {
  await persistentNativeResult('agent.rollover-bootstrap', { slotId, rolloverId, attemptId });
}

export async function completeNativeAgentRollover(slotId: string, attemptId: string): Promise<void> {
  await persistentNativeResult('agent.rollover-complete', { slotId, attemptId });
}

export async function failNativeAgentRollover(slotId: string, error: string): Promise<void> {
  await persistentNativeResult('agent.rollover-fail', { slotId, error });
}

export async function readNativeAgentRolloverStatus(slotId: string): Promise<NativeRolloverStatus | null> {
  return parseRolloverStatus(await persistentNativeResult('agent.rollover-status', { slotId }));
}

export async function readNativeWorkSnapshot(): Promise<NativeWorkSnapshot> {
  return parseNativeWorkSnapshot(await persistentNativeResult('work.snapshot', {}));
}

export async function replaceNativeWorkState(input: NativeWorkSnapshot): Promise<NativeWorkSnapshot> {
  const generation = await workTransportGeneration();
  const sequence = input.revision + 1;
  const payloadHash = await workPayloadHash(input);
  const transportMessageId = `work:${generation}:${sequence}:${payloadHash}`;
  const request = {
    id: crypto.randomUUID(),
    method: 'work.replace' as const,
    params: {
      expectedRevision: input.revision,
      transportGeneration: generation,
      transportSequence: sequence,
      transportMessageId,
      tasks: input.tasks,
      attempts: input.attempts,
      messages: input.messages,
    },
  };
  const response = await sendRetriedWorkRequest(request);
  return parseNativeWorkSnapshot(nativeResult(response, request.id, request.method));
}

export async function mutateNativeWorkDocument(input: {
  kind: 'task' | 'attempt' | 'message';
  expectedRevision: number;
  document: Record<string, unknown>;
}): Promise<number> {
  const generation = await workTransportGeneration();
  const sequence = input.expectedRevision + 1;
  const digest = await sha256Json({ kind: input.kind, expectedRevision: input.expectedRevision, document: input.document });
  const transportMessageId = `work-mutate:${generation}:${sequence}:${digest}`;
  const request = {
    id: crypto.randomUUID(),
    method: 'work.mutate' as const,
    params: {
      kind: input.kind,
      expectedRevision: input.expectedRevision,
      transportGeneration: generation,
      transportSequence: sequence,
      transportMessageId,
      document: input.document,
    },
  };
  const response = await sendRetriedWorkRequest(request);
  const result = record(nativeResult(response, request.id, request.method), 'work mutation result');
  return numberField(result.revision, 'work mutation revision');
}

export async function batchMutateNativeWorkDocuments(input: {
  expectedRevision: number;
  mutations: readonly NativeWorkDocumentMutation[];
}): Promise<number> {
  if (input.mutations.length === 0 || input.mutations.length > 32) throw new Error('Native work batch must contain between 1 and 32 mutations');
  const generation = await workTransportGeneration();
  const sequence = input.expectedRevision + 1;
  const mutations = input.mutations.map((mutation) => ({ kind: mutation.kind, document: mutation.document }));
  const digest = await sha256Json({ expectedRevision: input.expectedRevision, mutations });
  const transportMessageId = `work-batch:${generation}:${sequence}:${digest}`;
  const request = {
    id: crypto.randomUUID(),
    method: 'work.batch-mutate' as const,
    params: {
      expectedRevision: input.expectedRevision,
      transportGeneration: generation,
      transportSequence: sequence,
      transportMessageId,
      mutations,
    },
  };
  const response = await sendRetriedWorkRequest(request);
  const result = record(nativeResult(response, request.id, request.method), 'work batch mutation result');
  return numberField(result.revision, 'work batch mutation revision');
}

export async function provisionNativeTaskWorkspace(input: { projectId: string; slotId: string; taskId: string }): Promise<NativeTaskWorkspace> {
  return parseNativeTaskWorkspace(await persistentNativeResult('workspace.provision', input));
}

export async function projectNativeOrganizationWork(workItemId: string): Promise<NativeOrganizationExecutionProjection> {
  return parseOrganizationExecutionProjection(await persistentNativeResult('org-work.project-execution', { workItemId }));
}

export async function reconcileNativeElasticFleet(): Promise<unknown> {
  return persistentNativeResult('fleet.reconcile', {});
}

export async function reportNativeAgentRuntime(input: AgentRuntimeReportInput): Promise<void> {
  await persistentNativeResult('agent.runtime-report', input as unknown as Record<string, unknown>);
}

export async function planNativeBrowserOperation(input: {
  id: string;
  idempotencyKey: string;
  operation: string;
  projectId?: string;
  slotId?: string;
  conversationKey?: string;
  tabId?: number;
  contentEpoch?: string;
  preconditionsHash: string;
  plannedAt: number;
}): Promise<void> {
  await persistentNativeResult('browser.operation-plan', input as unknown as Record<string, unknown>);
}

export async function dispatchNativeBrowserOperation(id: string, dispatchedAt = Date.now()): Promise<void> {
  await persistentNativeResult('browser.operation-dispatch', { id, dispatchedAt });
}

export async function settleNativeBrowserOperation(
  id: string,
  outcome: 'acknowledged' | 'reply-observed' | 'failed' | 'uncertain',
  evidence: Record<string, unknown>,
  settledAt = Date.now(),
): Promise<void> {
  await persistentNativeResult('browser.operation-settle', { id, outcome, evidence, settledAt });
}

export async function reportNativeIncident(input: {
  scope: string;
  severity: 'warning' | 'error' | 'critical';
  code: string;
  subject: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await persistentNativeResult('incident.report', input as unknown as Record<string, unknown>);
}
