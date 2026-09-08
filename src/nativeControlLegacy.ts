import { nativeResult, parseNativeRpcResponse, type NativeRpcResponse } from './nativeRpcContract';

export const NATIVE_CONTROL_HOST = 'com.charterion.control';
const PROJECT_STATUSES = new Set(['active', 'draining', 'paused', 'archived']);
const AGENT_STATUSES = new Set(['idle', 'assigned', 'suspended', 'retired']);
const AGENT_DESIRED_STATES = new Set(['active','suspended','retired']);
const AGENT_BROWSER_STATES = new Set(['absent','opening','open','closing','error']);
const LEASE_MODES = new Set(['shared', 'exclusive']);
const LEASE_STATUSES = new Set(['active', 'released', 'expired']);
const WORKSPACE_STATUSES = new Set(['active', 'released']);
const CHANGE_STATUSES = new Set(['open','changes-requested','approved','queued','integrated','closed']);
const REVIEW_VERDICTS = new Set(['approve','request-changes']);
const QUEUE_STATUSES = new Set(['queued','validating','integrated','failed','cancelled']);
const BROWSER_AUTH_STATUSES = new Set(['unknown','authenticated','authentication-required']);
const BROWSER_PAGE_HEALTHS = new Set(['unknown','ready','generating','blocked','error','unavailable']);
const WORKER_REQUEST_TYPES = new Set(['suggestion','blocker','question','resource-request','scope-change','dependency-request','cross-system-request','review-request','risk-alert','worker-request']);
const WORKER_REQUEST_STATUSES = new Set(['open','accepted','rejected','resolved']);

export interface ControlProjectView {
  id: string;
  name: string;
  rootPath: string;
  status: 'active' | 'draining' | 'paused' | 'archived';
  isolationTier: string;
  minSlots: number;
  maxSlots: number;
  weight: number;
}

export interface ControlAgentView {
  id: string;
  projectId: string;
  role: string;
  status: 'idle' | 'assigned' | 'suspended' | 'retired';
  desiredState: 'active' | 'suspended' | 'retired';
  browserState: 'absent' | 'opening' | 'open' | 'closing' | 'error';
  conversationKey?: string;
  conversationGeneration: number;
  rolloverState: 'idle'|'requested'|'opening'|'bootstrapping';
  activeRolloverId?: string;
  browserProfileId?: string;
  browserTabId?: number;
  browserError?: string;
  browserObservedAt?: number;
  browserLeaseId?: string;
  browserLeaseEpoch?: number;
  browserContentEpoch?: string;
  browserObservationRevision?: number;
  browserPageStatus?: import('./contracts').AgentStatus;
  browserRuntimeObservedAt?: number;
  browserQuarantined: boolean;
  browserQuarantineReason?: string;
  leaseEpoch: number;
}

export interface ControlResourceView {
  id: string;
  projectId?: string;
  parentId?: string;
  kind: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface ControlLeaseView {
  id: string;
  resourceId: string;
  projectId: string;
  holderId: string;
  taskId?: string;
  mode: 'shared' | 'exclusive';
  epoch: number;
  status: 'active' | 'released' | 'expired';
  expiresAt?: number;
}

export interface ControlEventView {
  seq: number;
  projectId?: string;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ControlChangeRequestView {
  id: string; projectId: string; taskId: string; authorSubject: string; branch: string; targetBranch: string; baseSha: string; headSha: string; claimId: string;
  revision: number; status: 'open'|'changes-requested'|'approved'|'queued'|'integrated'|'closed';
}
export interface ControlReviewView {
  id: string; projectId: string; changeRequestId: string; reviewerSubject: string; headSha: string; verdict: 'approve'|'request-changes'; body: string; createdAt: number;
}
export interface ControlMergeQueueView {
  id: string; projectId: string; changeRequestId: string; headSha: string; targetBranch: string; status: 'queued'|'validating'|'integrated'|'failed'|'cancelled'; queuedAt: number; updatedAt: number;
  candidateBaseSha?: string; candidateSha?: string; error?: string; integratedSha?: string;
}

export interface ControlBrowserRuntimeView {
  profileId: string;
  authStatus: 'unknown' | 'authenticated' | 'authentication-required';
  pageHealth: 'unknown' | 'ready' | 'generating' | 'blocked' | 'error' | 'unavailable';
  openTabs: number;
  extensionVersion: string;
  observedAt: number;
}

export interface BrowserRuntimeReportInput {
  profileId: string;
  authStatus: ControlBrowserRuntimeView['authStatus'];
  pageHealth: ControlBrowserRuntimeView['pageHealth'];
  openTabs: number;
  extensionVersion: string;
  observedAt: number;
}
export interface ControlWorkerRequestView {
  id: string; projectId: string; taskId?: string; fromSubject: string;
  type: 'suggestion'|'blocker'|'question'|'resource-request'|'scope-change'|'dependency-request'|'cross-system-request'|'review-request'|'risk-alert'|'worker-request';
  title: string; body: string; suggestedAction?: string; status: 'open'|'accepted'|'rejected'|'resolved';
  decidedBy?: string; decisionNote?: string; createdAt: number; updatedAt: number;
}

export interface NativeControlSnapshot {
  protocolVersion: 2;
  projects: ControlProjectView[];
  agents: ControlAgentView[];
  resources: ControlResourceView[];
  leases: ControlLeaseView[];
  changeRequests: ControlChangeRequestView[];
  reviews: ControlReviewView[];
  mergeQueue: ControlMergeQueueView[];
  workerRequests: ControlWorkerRequestView[];
  browserRuntime: ControlBrowserRuntimeView[];
  events: ControlEventView[];
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
  if (!allowed.has(text)) throw new Error(label + ' is invalid');
  return text;
}

function arrayField(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringArrayField(value: unknown, label: string): string[] {
  const array = arrayField(value, label);
  if (!array.every((item) => typeof item === 'string' && item.trim().length > 0)) throw new Error(`${label} must contain non-empty strings`);
  return array as string[];
}

export function parseNativeControlSnapshot(value: unknown): NativeControlSnapshot {
  const root = record(value, 'control snapshot');
  if (root.protocolVersion !== 2) throw new Error('Unsupported control protocol version');
  const projects = arrayField(root.projects, 'projects').map((entry, index) => {
    const item = record(entry, `projects[${index}]`);
    return {
      id: stringField(item.id, 'project.id'), name: stringField(item.name, 'project.name'),
      rootPath: stringField(item.rootPath, 'project.rootPath'), status: enumField(item.status, 'project.status', PROJECT_STATUSES) as ControlProjectView['status'],
      isolationTier: stringField(item.isolationTier, 'project.isolationTier'), minSlots: numberField(item.minSlots, 'project.minSlots'),
      maxSlots: numberField(item.maxSlots, 'project.maxSlots'), weight: numberField(item.weight, 'project.weight'),
    };
  });
  const agents = arrayField(root.agents, 'agents').map((entry, index) => {
    const item = record(entry, `agents[${index}]`);
    const agent: ControlAgentView = {
      id: stringField(item.id, 'agent.id'), projectId: stringField(item.projectId, 'agent.projectId'),
      role: stringField(item.role, 'agent.role'), status: enumField(item.status, 'agent.status', AGENT_STATUSES) as ControlAgentView['status'],
      desiredState: enumField(item.desiredState, 'agent.desiredState', AGENT_DESIRED_STATES) as ControlAgentView['desiredState'],
      browserState: enumField(item.browserState, 'agent.browserState', AGENT_BROWSER_STATES) as ControlAgentView['browserState'],
      conversationGeneration: numberField(item.conversationGeneration, 'agent.conversationGeneration'),
      rolloverState: stringField(item.rolloverState, 'agent.rolloverState') as ControlAgentView['rolloverState'],
      browserQuarantined: item.browserQuarantined === true,
      leaseEpoch: numberField(item.leaseEpoch, 'agent.leaseEpoch'),
    };
    if (item.conversationKey !== undefined) agent.conversationKey = stringField(item.conversationKey, 'agent.conversationKey');
    if (item.activeRolloverId !== undefined) agent.activeRolloverId = stringField(item.activeRolloverId, 'agent.activeRolloverId');
    if (item.browserProfileId !== undefined) agent.browserProfileId = stringField(item.browserProfileId, 'agent.browserProfileId');
    if (item.browserTabId !== undefined) agent.browserTabId = numberField(item.browserTabId, 'agent.browserTabId');
    if (item.browserError !== undefined) agent.browserError = stringField(item.browserError, 'agent.browserError');
    if (item.browserObservedAt !== undefined) agent.browserObservedAt = numberField(item.browserObservedAt, 'agent.browserObservedAt');
    if (item.browserLeaseId !== undefined) agent.browserLeaseId = stringField(item.browserLeaseId, 'agent.browserLeaseId');
    if (item.browserLeaseEpoch !== undefined) agent.browserLeaseEpoch = numberField(item.browserLeaseEpoch, 'agent.browserLeaseEpoch');
    if (item.browserContentEpoch !== undefined) agent.browserContentEpoch = stringField(item.browserContentEpoch, 'agent.browserContentEpoch');
    if (item.browserObservationRevision !== undefined) agent.browserObservationRevision = numberField(item.browserObservationRevision, 'agent.browserObservationRevision');
    if (item.browserPageStatus !== undefined) agent.browserPageStatus = stringField(item.browserPageStatus, 'agent.browserPageStatus') as NonNullable<ControlAgentView['browserPageStatus']>;
    if (item.browserRuntimeObservedAt !== undefined) agent.browserRuntimeObservedAt = numberField(item.browserRuntimeObservedAt, 'agent.browserRuntimeObservedAt');
    if (item.browserQuarantineReason !== undefined) agent.browserQuarantineReason = stringField(item.browserQuarantineReason, 'agent.browserQuarantineReason');
    return agent;
  });
  const resources = arrayField(root.resources, 'resources').map((entry, index) => {
    const item = record(entry, `resources[${index}]`);
    const resource: ControlResourceView = {
      id: stringField(item.id, 'resource.id'), kind: stringField(item.kind, 'resource.kind'),
      label: stringField(item.label, 'resource.label'), metadata: record(item.metadata, 'resource.metadata'),
    };
    if (item.projectId !== undefined) resource.projectId = stringField(item.projectId, 'resource.projectId');
    if (item.parentId !== undefined) resource.parentId = stringField(item.parentId, 'resource.parentId');
    return resource;
  });
  const leases = arrayField(root.leases, 'leases').map((entry, index) => {
    const item = record(entry, `leases[${index}]`);
    const lease: ControlLeaseView = {
      id: stringField(item.id, 'lease.id'), resourceId: stringField(item.resourceId, 'lease.resourceId'),
      projectId: stringField(item.projectId, 'lease.projectId'), holderId: stringField(item.holderId, 'lease.holderId'),
      mode: enumField(item.mode, 'lease.mode', LEASE_MODES) as ControlLeaseView['mode'], epoch: numberField(item.epoch, 'lease.epoch'),
      status: enumField(item.status, 'lease.status', LEASE_STATUSES) as ControlLeaseView['status'],
    };
    if (item.taskId !== undefined) lease.taskId = stringField(item.taskId, 'lease.taskId');
    if (item.expiresAt !== undefined) lease.expiresAt = numberField(item.expiresAt, 'lease.expiresAt');
    return lease;
  });
  const changeRequests = arrayField(root.changeRequests, 'changeRequests').map((entry, index) => {
    const item = record(entry, `changeRequests[${index}]`);
    return { id: stringField(item.id,'change.id'), projectId: stringField(item.projectId,'change.projectId'), taskId: stringField(item.taskId,'change.taskId'),
      authorSubject: stringField(item.authorSubject,'change.authorSubject'), branch: stringField(item.branch,'change.branch'), targetBranch: stringField(item.targetBranch,'change.targetBranch'),
      baseSha: stringField(item.baseSha,'change.baseSha'), headSha: stringField(item.headSha,'change.headSha'), claimId: stringField(item.claimId,'change.claimId'),
      revision: numberField(item.revision,'change.revision'), status: enumField(item.status,'change.status',CHANGE_STATUSES) as ControlChangeRequestView['status'] };
  });
  const reviews = arrayField(root.reviews, 'reviews').map((entry, index) => {
    const item = record(entry, `reviews[${index}]`);
    return { id: stringField(item.id,'review.id'), projectId: stringField(item.projectId,'review.projectId'), changeRequestId: stringField(item.changeRequestId,'review.changeRequestId'),
      reviewerSubject: stringField(item.reviewerSubject,'review.reviewerSubject'), headSha: stringField(item.headSha,'review.headSha'),
      verdict: enumField(item.verdict,'review.verdict',REVIEW_VERDICTS) as ControlReviewView['verdict'], body: stringField(item.body,'review.body'), createdAt: numberField(item.createdAt,'review.createdAt') };
  });
  const mergeQueue = arrayField(root.mergeQueue, 'mergeQueue').map((entry, index) => {
    const item = record(entry, `mergeQueue[${index}]`);
    const queue: ControlMergeQueueView = { id: stringField(item.id,'queue.id'), projectId: stringField(item.projectId,'queue.projectId'), changeRequestId: stringField(item.changeRequestId,'queue.changeRequestId'),
      headSha: stringField(item.headSha,'queue.headSha'), targetBranch: stringField(item.targetBranch,'queue.targetBranch'), status: enumField(item.status,'queue.status',QUEUE_STATUSES) as ControlMergeQueueView['status'],
      queuedAt: numberField(item.queuedAt,'queue.queuedAt'), updatedAt: numberField(item.updatedAt,'queue.updatedAt') };
    if (item.candidateBaseSha !== undefined) queue.candidateBaseSha = stringField(item.candidateBaseSha,'queue.candidateBaseSha');
    if (item.candidateSha !== undefined) queue.candidateSha = stringField(item.candidateSha,'queue.candidateSha');
    if (item.error !== undefined) queue.error = stringField(item.error,'queue.error');
    if (item.integratedSha !== undefined) queue.integratedSha = stringField(item.integratedSha,'queue.integratedSha');
    return queue;
  });
  const workerRequests = arrayField(root.workerRequests, 'workerRequests').map((entry, index) => {
    const item = record(entry, `workerRequests[${index}]`);
    const request: ControlWorkerRequestView = {
      id: stringField(item.id,'request.id'), projectId: stringField(item.projectId,'request.projectId'), fromSubject: stringField(item.fromSubject,'request.fromSubject'),
      type: enumField(item.type,'request.type',WORKER_REQUEST_TYPES) as ControlWorkerRequestView['type'], title: stringField(item.title,'request.title'), body: stringField(item.body,'request.body'),
      status: enumField(item.status,'request.status',WORKER_REQUEST_STATUSES) as ControlWorkerRequestView['status'], createdAt: numberField(item.createdAt,'request.createdAt'), updatedAt: numberField(item.updatedAt,'request.updatedAt'),
    };
    if (item.taskId !== undefined) request.taskId = stringField(item.taskId,'request.taskId');
    if (item.suggestedAction !== undefined) request.suggestedAction = stringField(item.suggestedAction,'request.suggestedAction');
    if (item.decidedBy !== undefined) request.decidedBy = stringField(item.decidedBy,'request.decidedBy');
    if (item.decisionNote !== undefined) request.decisionNote = stringField(item.decisionNote,'request.decisionNote');
    return request;
  });
  const browserRuntime = arrayField(root.browserRuntime, 'browserRuntime').map((entry, index) => {
    const item = record(entry, `browserRuntime[${index}]`);
    return {
      profileId: stringField(item.profileId, 'browser.profileId'),
      authStatus: enumField(item.authStatus, 'browser.authStatus', BROWSER_AUTH_STATUSES) as ControlBrowserRuntimeView['authStatus'],
      pageHealth: enumField(item.pageHealth, 'browser.pageHealth', BROWSER_PAGE_HEALTHS) as ControlBrowserRuntimeView['pageHealth'],
      openTabs: numberField(item.openTabs, 'browser.openTabs'),
      extensionVersion: stringField(item.extensionVersion, 'browser.extensionVersion'),
      observedAt: numberField(item.observedAt, 'browser.observedAt'),
    };
  });  const events = arrayField(root.events, 'events').map((entry, index) => {
    const item = record(entry, `events[${index}]`);
    const event: ControlEventView = {
      seq: numberField(item.seq, 'event.seq'), type: stringField(item.type, 'event.type'),
      subject: stringField(item.subject, 'event.subject'), payload: record(item.payload, 'event.payload'),
      createdAt: numberField(item.createdAt, 'event.createdAt'),
    };
    if (item.projectId !== undefined) event.projectId = stringField(item.projectId, 'event.projectId');
    return event;
  });
  return { protocolVersion: 2, projects, agents, resources, leases, changeRequests, reviews, mergeQueue, workerRequests, browserRuntime, events };
}

export async function readNativeControlSnapshot(): Promise<NativeControlSnapshot> {
  const request = { id: crypto.randomUUID(), method: 'control.snapshot', params: {} };
  let response: NativeRpcResponse;
  try {
    response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Native control plane is unavailable: ${reason}`);
  }
  return parseNativeControlSnapshot(nativeResult(response, request.id, request.method));
}

export async function reportNativeBrowserRuntime(input: BrowserRuntimeReportInput): Promise<void> {
  const request = { id: crypto.randomUUID(), method: 'browser.report', params: input };
  let response: NativeRpcResponse;
  try {
    response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Native control plane is unavailable: ${reason}`);
  }
  nativeResult(response, request.id, request.method);
}

export interface AgentBrowserReportInput {
  slotId: string; profileId: string; browserState: ControlAgentView['browserState'];
  tabId?: number; conversationKey?: string; error?: string; observedAt: number;
}

export async function reportNativeAgentBrowser(input: AgentBrowserReportInput): Promise<void> {
  const request = { id: crypto.randomUUID(), method: 'agent.browser-report', params: input };
  let response: NativeRpcResponse;
  try { response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request)); }
  catch (error) { throw new Error(`Native control plane is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  nativeResult(response, request.id, request.method);
}

export interface NativeRolloverStatus { rollover: { id: string; slotId: string; status: 'requested'|'opening'|'bootstrapping'; checkpointId: string; fromConversationKey: string; toConversationKey?: string; bootstrapAttemptId?: string; reason: string; }; checkpoint: { id: string; handoffText: string; reason: string; state: Record<string, unknown>; }; }
const ROLLOVER_STATUSES = new Set(['requested', 'opening', 'bootstrapping']);

function parseNativeRolloverStatus(value: unknown): NativeRolloverStatus | null {
  if (value === null) return null;
  const root = record(value, 'rollover status');
  const rollover = record(root.rollover, 'rollover');
  const checkpoint = record(root.checkpoint, 'checkpoint');
  const result: NativeRolloverStatus = {
    rollover: { id: stringField(rollover.id, 'rollover.id'), slotId: stringField(rollover.slotId, 'rollover.slotId'),
      status: enumField(rollover.status, 'rollover.status', ROLLOVER_STATUSES) as NativeRolloverStatus['rollover']['status'],
      checkpointId: stringField(rollover.checkpointId, 'rollover.checkpointId'), fromConversationKey: stringField(rollover.fromConversationKey, 'rollover.fromConversationKey'),
      reason: stringField(rollover.reason, 'rollover.reason') },
    checkpoint: { id: stringField(checkpoint.id, 'checkpoint.id'), handoffText: stringField(checkpoint.handoffText, 'checkpoint.handoffText'),
      reason: stringField(checkpoint.reason, 'checkpoint.reason'), state: record(checkpoint.state, 'checkpoint.state') },
  };
  if (rollover.toConversationKey !== undefined) result.rollover.toConversationKey = stringField(rollover.toConversationKey, 'rollover.toConversationKey');
  if (rollover.bootstrapAttemptId !== undefined) result.rollover.bootstrapAttemptId = stringField(rollover.bootstrapAttemptId, 'rollover.bootstrapAttemptId');
  return result;
}

export async function requestNativeAgentRollover(input: { slotId: string; reason: string; handoffText: string; state: Record<string, unknown> }): Promise<void> { await sendNativeMutation('agent.rollover-request', input as unknown as Record<string, unknown>); }
export async function beginNativeAgentRollover(slotId: string, rolloverId: string): Promise<void> { await sendNativeMutation('agent.rollover-begin', { slotId, rolloverId }); }
export async function markNativeAgentRolloverBootstrap(slotId: string, rolloverId: string, attemptId: string): Promise<void> { await sendNativeMutation('agent.rollover-bootstrap', { slotId, rolloverId, attemptId }); }
export async function completeNativeAgentRollover(slotId: string, attemptId: string): Promise<void> { await sendNativeMutation('agent.rollover-complete', { slotId, attemptId }); }
export async function failNativeAgentRollover(slotId: string, error: string): Promise<void> { await sendNativeMutation('agent.rollover-fail', { slotId, error }); }
export async function readNativeAgentRolloverStatus(slotId: string): Promise<NativeRolloverStatus | null> {
  return parseNativeRolloverStatus(await sendNativeMutation('agent.rollover-status', { slotId }));
}

export interface NativeWorkSnapshot {
  revision: number;
  tasks: import('./contracts').AgentTask[];
  attempts: import('./contracts').SendAttemptRecord[];
  messages: import('./contracts').AgentMessage[];
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

export async function readNativeWorkSnapshot(): Promise<NativeWorkSnapshot> {
  const request = { id: crypto.randomUUID(), method: 'work.snapshot', params: {} };
  let response: NativeRpcResponse;
  try { response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request)); }
  catch (error) { throw new Error(`Native control plane is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  return parseNativeWorkSnapshot(nativeResult(response, request.id, request.method));
}

const WORK_TRANSPORT_KEY = 'nativeWorkTransport.v1';

async function workTransportGeneration(): Promise<string> {
  const stored = await chrome.storage.session.get(WORK_TRANSPORT_KEY);
  const current = stored[WORK_TRANSPORT_KEY];
  if (typeof current === 'string' && current) return current;
  const generation = crypto.randomUUID();
  await chrome.storage.session.set({ [WORK_TRANSPORT_KEY]: generation });
  return generation;
}

async function workPayloadHash(input: NativeWorkSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ revision: input.revision, tasks: input.tasks, attempts: input.attempts, messages: input.messages }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function replaceNativeWorkState(input: NativeWorkSnapshot): Promise<NativeWorkSnapshot> {
  const generation = await workTransportGeneration();
  const sequence = input.revision + 1;
  const payloadHash = await workPayloadHash(input);
  const transportMessageId = `work:${generation}:${sequence}:${payloadHash}`;
  const request = {
    id: crypto.randomUUID(), method: 'work.replace',
    params: { expectedRevision: input.revision, transportGeneration: generation, transportSequence: sequence, transportMessageId, tasks: input.tasks, attempts: input.attempts, messages: input.messages },
  };
  let response: NativeRpcResponse | undefined;
  let transportError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request)); transportError = undefined; break; }
    catch (error) { transportError = error; }
  }
  if (transportError || !response) throw new Error(`Native control plane is unavailable: ${transportError instanceof Error ? transportError.message : String(transportError)}`);
  return parseNativeWorkSnapshot(nativeResult(response, request.id, request.method));
}

export async function mutateNativeWorkDocument(input: { kind: 'task' | 'attempt' | 'message'; expectedRevision: number; document: Record<string, unknown> }): Promise<number> {
  const generation = await workTransportGeneration();
  const sequence = input.expectedRevision + 1;
  const payloadHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ kind: input.kind, expectedRevision: input.expectedRevision, document: input.document })));
  const digest = [...new Uint8Array(payloadHash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const transportMessageId = `work-mutate:${generation}:${sequence}:${digest}`;
  const request = {
    id: crypto.randomUUID(), method: 'work.mutate',
    params: { kind: input.kind, expectedRevision: input.expectedRevision, transportGeneration: generation, transportSequence: sequence, transportMessageId, document: input.document },
  };
  let response: NativeRpcResponse | undefined;
  let transportError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request)); transportError = undefined; break; }
    catch (error) { transportError = error; }
  }
  if (transportError || !response) throw new Error(`Native control plane is unavailable: ${transportError instanceof Error ? transportError.message : String(transportError)}`);
  const result = record(nativeResult(response, request.id, request.method), 'work mutation result');
  return numberField(result.revision, 'work mutation revision');
}

export interface NativeTaskWorkspace {
  id: string; projectId: string; taskId: string; slotId: string; repoPath: string; path: string; branch: string; baseSha: string;
  resourceId: string; leaseId: string; leaseEpoch: number; capabilityId: string; capabilityTokenPath: string; controlCliPath: string; status: 'active'|'released';
}

export function parseNativeTaskWorkspace(value: unknown): NativeTaskWorkspace {
  const item = record(value, 'task workspace');
  return {
    id: stringField(item.id,'workspace.id'), projectId: stringField(item.projectId,'workspace.projectId'), taskId: stringField(item.taskId,'workspace.taskId'),
    slotId: stringField(item.slotId,'workspace.slotId'), repoPath: stringField(item.repoPath,'workspace.repoPath'), path: stringField(item.path,'workspace.path'),
    branch: stringField(item.branch,'workspace.branch'), baseSha: stringField(item.baseSha,'workspace.baseSha'), resourceId: stringField(item.resourceId,'workspace.resourceId'),
    leaseId: stringField(item.leaseId,'workspace.leaseId'), leaseEpoch: numberField(item.leaseEpoch,'workspace.leaseEpoch'), capabilityId: stringField(item.capabilityId,'workspace.capabilityId'),
    capabilityTokenPath: stringField(item.capabilityTokenPath,'workspace.capabilityTokenPath'), controlCliPath: stringField(item.controlCliPath,'workspace.controlCliPath'), status: enumField(item.status,'workspace.status', WORKSPACE_STATUSES) as NativeTaskWorkspace['status'],
  };
}

export async function provisionNativeTaskWorkspace(input: { projectId: string; slotId: string; taskId: string }): Promise<NativeTaskWorkspace> {
  return parseNativeTaskWorkspace(await sendNativeMutation('workspace.provision', input));
}

export interface NativeOrganizationExecutionProjection {
  workItemId: string; missionId: string; organizationAgentId: string; projectId: string;
  runtimeSlotId: string; managerTaskId: string; task: import('./contracts').AgentTask;
}

function parseNativeOrganizationExecutionProjection(value: unknown): NativeOrganizationExecutionProjection {
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

export async function projectNativeOrganizationWork(workItemId: string): Promise<NativeOrganizationExecutionProjection> {
  return parseNativeOrganizationExecutionProjection(await sendNativeMutation('org-work.project-execution', { workItemId }));
}


export interface AgentRuntimeReportInput {
  slotId: string; profileId: string; tabId: number; contentEpoch: string; revision: number;
  pageStatus: import('./contracts').AgentStatus; semanticSignature: string; observedAt: number;
}

async function sendNativeMutation(method: string, params: Record<string, unknown>): Promise<unknown> {
  const request = { id: crypto.randomUUID(), method, params };
  let response: NativeRpcResponse;
  try { response = await parseNativeRpcResponse(await chrome.runtime.sendNativeMessage(NATIVE_CONTROL_HOST, request)); }
  catch (error) { throw new Error(`Native control plane is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  return nativeResult(response, request.id, method);
}

export async function reconcileNativeElasticFleet(): Promise<unknown> {
  return await sendNativeMutation('fleet.reconcile', {});
}

export async function reportNativeAgentRuntime(input: AgentRuntimeReportInput): Promise<void> {
  await sendNativeMutation('agent.runtime-report', input as unknown as Record<string, unknown>);
}

export async function planNativeBrowserOperation(input: { id: string; idempotencyKey: string; operation: string; projectId?: string; slotId?: string; conversationKey?: string; tabId?: number; contentEpoch?: string; preconditionsHash: string; plannedAt: number }): Promise<void> {
  await sendNativeMutation('browser.operation-plan', input as unknown as Record<string, unknown>);
}
export async function dispatchNativeBrowserOperation(id: string, dispatchedAt = Date.now()): Promise<void> {
  await sendNativeMutation('browser.operation-dispatch', { id, dispatchedAt });
}
export async function settleNativeBrowserOperation(id: string, outcome: 'acknowledged'|'reply-observed'|'failed'|'uncertain', evidence: Record<string, unknown>, settledAt = Date.now()): Promise<void> {
  await sendNativeMutation('browser.operation-settle', { id, outcome, evidence, settledAt });
}
export async function reportNativeIncident(input: { scope: string; severity: 'warning'|'error'|'critical'; code: string; subject: string; detail?: Record<string, unknown> }): Promise<void> {
  await sendNativeMutation('incident.report', input as unknown as Record<string, unknown>);
}