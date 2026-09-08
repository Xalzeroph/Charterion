import { advanceAttempt } from './attempts';
import { retainAttemptLedger } from './attemptLedger';
import { normalizeTask } from './taskPolicy';
import {
  batchMutateNativeWorkDocuments,
  mutateNativeWorkDocument,
  readNativeWorkSnapshot,
  replaceNativeWorkState,
  settleNativeBrowserOperation,
  type NativeWorkDocumentMutation,
} from './nativeControl';
import { reportIncident } from './browserRuntimeReporting';
import { MutationLane } from './mutationLane';
import type { AgentMessage, AgentTask, ChatSnapshot, SendAttemptRecord, SendAttemptState } from './contracts';

export interface WorkState {
  revision: number;
  attempts: SendAttemptRecord[];
  tasks: AgentTask[];
  messages: AgentMessage[];
}

const mutationLane = new MutationLane();
const MAX_AUTOMATIC_BATCH_MUTATIONS = 8;

type WorkCollection = AgentTask[] | SendAttemptRecord[] | AgentMessage[];
type WorkKind = NativeWorkDocumentMutation['kind'];

function itemId(kind: WorkKind, value: AgentTask | SendAttemptRecord | AgentMessage): string {
  return kind === 'attempt'
    ? (value as SendAttemptRecord).attemptId
    : (value as AgentTask | AgentMessage).id;
}

function collectionMutations(
  kind: WorkKind,
  current: WorkCollection,
  next: WorkCollection,
): NativeWorkDocumentMutation[] | undefined {
  if (next.length < current.length) return undefined;
  const mutations: NativeWorkDocumentMutation[] = [];
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index]!;
    const after = next[index]!;
    if (itemId(kind, before) !== itemId(kind, after)) return undefined;
    if (before !== after) mutations.push({ kind, document: after as unknown as Record<string, unknown> });
  }
  for (let index = current.length; index < next.length; index += 1) {
    mutations.push({ kind, document: next[index]! as unknown as Record<string, unknown> });
  }
  return mutations;
}

export function planWorkPatchMutations(
  current: WorkState,
  next: Pick<WorkState, 'attempts' | 'tasks' | 'messages'>,
  limit = MAX_AUTOMATIC_BATCH_MUTATIONS,
): NativeWorkDocumentMutation[] | undefined {
  const tasks = collectionMutations('task', current.tasks, next.tasks);
  if (!tasks) return undefined;
  const attempts = collectionMutations('attempt', current.attempts, next.attempts);
  if (!attempts) return undefined;
  const messages = collectionMutations('message', current.messages, next.messages);
  if (!messages) return undefined;
  const mutations = [...tasks, ...attempts, ...messages];
  return mutations.length <= Math.max(0, limit) ? mutations : undefined;
}

export async function readWorkState(): Promise<WorkState> {
  const state = await readNativeWorkSnapshot();
  return { revision: state.revision, attempts: state.attempts, tasks: state.tasks.map(normalizeTask), messages: state.messages };
}

export async function replaceWorkState(current: WorkState, patch: Partial<Pick<WorkState, 'attempts' | 'tasks' | 'messages'>>): Promise<WorkState> {
  const attempts = patch.attempts ?? current.attempts;
  const tasks = patch.tasks ?? current.tasks;
  const messages = patch.messages ?? current.messages;
  const mutations = planWorkPatchMutations(current, { attempts, tasks, messages });
  if (mutations && mutations.length > 0) {
    const revision = await batchMutateNativeWorkDocuments({ expectedRevision: current.revision, mutations });
    return { revision, attempts, tasks: tasks.map(normalizeTask), messages };
  }
  if (mutations?.length === 0) return current;

  const next = await replaceNativeWorkState({ revision: current.revision, attempts, tasks, messages });
  return { revision: next.revision, attempts: next.attempts, tasks: next.tasks.map(normalizeTask), messages: next.messages };
}

export function serializeStateMutation<T>(operation: () => Promise<T>): Promise<T> {
  return mutationLane.run(operation);
}

export async function workState(): Promise<WorkState> {
  await mutationLane.waitForIdle();
  return readWorkState();
}

async function persistAttemptDocument(
  current: WorkState,
  record: SendAttemptRecord,
  alreadyPresent: boolean,
): Promise<void> {
  if (alreadyPresent) {
    await mutateNativeWorkDocument({ kind: 'attempt', expectedRevision: current.revision, document: record as unknown as Record<string, unknown> });
    return;
  }

  const merged = [...current.attempts, record];
  const retained = retainAttemptLedger(merged, current.tasks, current.messages);
  if (retained.length !== merged.length) {
    await replaceWorkState(current, { attempts: retained });
    return;
  }
  await mutateNativeWorkDocument({ kind: 'attempt', expectedRevision: current.revision, document: record as unknown as Record<string, unknown> });
}

export async function persistAttempt(record: SendAttemptRecord): Promise<void> {
  await serializeStateMutation(async () => {
    const current = await readWorkState();
    const alreadyPresent = current.attempts.some((item) => item.attemptId === record.attemptId);
    await persistAttemptDocument(current, record, alreadyPresent);
  });
}

export async function transitionAttempt(record: SendAttemptRecord, state: SendAttemptState, error?: string): Promise<SendAttemptRecord> {
  return serializeStateMutation(async () => {
    const currentState = await readWorkState();
    const existing = currentState.attempts.find((item) => item.attemptId === record.attemptId);
    const current = existing ?? record;
    const next = advanceAttempt(current, state, Date.now(), error);
    await persistAttemptDocument(currentState, next, existing !== undefined);
    return next;
  });
}

export async function markReplyObserved(attemptId: string, contentEpoch: string, snapshot: ChatSnapshot, senderTabId?: number): Promise<boolean> {
  const persisted = await serializeStateMutation(async () => {
    const state = await readWorkState();
    const current = state.attempts.find((item) => item.attemptId === attemptId);
    if (!current || current.contentEpoch !== contentEpoch || (senderTabId !== undefined && current.tabId !== senderTabId)) return false;
    if (current.state === 'reply-observed') return true;
    const advanced = advanceAttempt(current, 'reply-observed');
    if (advanced.state !== 'reply-observed') return false;
    const next: SendAttemptRecord = { ...advanced, replyObservedAt: Date.now(), replyTextTail: snapshot.latestAssistantText.slice(-8000) };
    if (snapshot.latestAssistantMessageId) next.replyMessageId = snapshot.latestAssistantMessageId;
    await mutateNativeWorkDocument({ kind: 'attempt', expectedRevision: state.revision, document: next as unknown as Record<string, unknown> });
    return true;
  });
  if (persisted) {
    await settleNativeBrowserOperation(attemptId, 'reply-observed', {
      contentEpoch, assistantMessageId: snapshot.latestAssistantMessageId ?? null, assistantMessageCount: snapshot.assistantMessageCount,
    }).catch(() => reportIncident('browser-operation-reply-settle-failed', attemptId, { contentEpoch }));
  }
  return persisted;
}
