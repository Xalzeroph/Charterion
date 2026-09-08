import { advanceAttempt } from './attempts';
import { retainAttemptLedger } from './attemptLedger';
import { normalizeTask } from './taskPolicy';
import { mutateNativeWorkDocument, readNativeWorkSnapshot, replaceNativeWorkState, settleNativeBrowserOperation } from './nativeControl';
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

export async function readWorkState(): Promise<WorkState> {
  const state = await readNativeWorkSnapshot();
  return { revision: state.revision, attempts: state.attempts, tasks: state.tasks.map(normalizeTask), messages: state.messages };
}

export async function replaceWorkState(current: WorkState, patch: Partial<Pick<WorkState, 'attempts' | 'tasks' | 'messages'>>): Promise<WorkState> {
  const next = await replaceNativeWorkState({ revision: current.revision, attempts: patch.attempts ?? current.attempts, tasks: patch.tasks ?? current.tasks, messages: patch.messages ?? current.messages });
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
