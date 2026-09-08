import { mapWithConcurrency } from './asyncPool';
import { advanceAttempt } from './attempts';
import { retainAttemptLedger } from './attemptLedger';
import { deriveManagedTasks, isRetryableTaskAttempt, validateTaskGraph } from './taskGraph';
import { markReplyObserved, persistAttempt, readWorkState, replaceWorkState, serializeStateMutation, transitionAttempt, workState, type WorkState } from './backgroundWorkState';
import { dispatchReadyManagedTasks } from './taskDispatchRuntime';
import { hasOrganizationExecutionTask, markOrganizationExecutionObserved } from './organizationWorkAutomation';
import { projectManagedTabs } from './managedTabProjection';
import { applyHumanDecision, applyTaskDisposition } from './taskLifecycle';
import { applyReviewRemediation } from './reviewLoop';
import { defaultCompletionPolicy, DEFAULT_MAX_REVIEW_ROUNDS, normalizeTask } from './taskPolicy';
import { parseReviewResult } from './review';
import { assertMessageDeliveryAvailable, buildSemanticMessagePrompt, createAgentMessage, planMessageDispatch } from './messageBus';
import { createPortableManagerState, parsePortableManagerState, restorePortableAttempts, stringifyPortableManagerState } from './stateTransfer';
import { recoverAttempt, type AttemptRecoveryObservation } from './recovery';
import { beginNativeAgentRollover, dispatchNativeBrowserOperation, planNativeBrowserOperation, mutateNativeWorkDocument, readNativeControlSnapshot, readNativeWorkSnapshot, replaceNativeWorkState, reportNativeAgentBrowser, reportNativeBrowserRuntime, reconcileNativeElasticFleet, settleNativeBrowserOperation } from './nativeControl';
import { planFleetReconciliation, workerRequestMessage } from './fleet';
import { bootstrapPendingConversationRollover, bootstrapReplyAttemptId, completeConversationRolloverForReply, requestAutomaticConversationRollover } from './conversationRollover';
import { deriveBrowserRuntimeObservation, fleetExpansionAllowed } from './browserRuntime';
import { CoalescingRunner } from './coalescingRunner';
import { TabOperationQueue } from './tabOperationQueue';
import { MutationLane } from './mutationLane';
import { FleetTabRegistry } from './fleetTabRegistry';
import { RUNTIME_STORAGE_KEYS } from './runtimeStorageKeys';
import { controlFeedbackMessages } from './controlFeedback';
import { ContentRuntimeFence } from './contentRuntimeFence';
import { browserOperationPolicy } from './browserOperationPolicy';
import { createBindingStore } from './bindingStore';
import { recoveryStateForTab, snapshotForTab } from './contentRuntimeBridge';
import { reportIncident, reportSlotRuntime, sha256Text } from './browserRuntimeReporting';
import { PROMPT_DISPATCH_GOVERNOR_KEY, PromptDispatchGovernor } from './promptDispatchGovernor';
import {
  EMPTY_BINDING,
  type AgentMessage,
  type AgentTask,
  type ChatSnapshot,
  type CreateTaskInput,
  type ManagedTab,
  type ManagerRequest,
  type RoleBinding,
  type RuntimeNotice,
  type SendAttemptRecord,
  type SendAttemptState,
  type SendResult,
  type TaskDispatchResult,
} from './contracts';
const {
  bindings: BINDINGS_KEY,
  tabBindings: TAB_BINDINGS_KEY,
  sendAttempts: SEND_ATTEMPTS_KEY,
  tasks: TASKS_KEY,
  messages: MESSAGES_KEY,
  supervisor: SUPERVISOR_KEY,
} = RUNTIME_STORAGE_KEYS;
const CONTROL_REQUEST_MESSAGE_PREFIX = 'control-request:';
const MAX_PARALLEL_BROWSER_PROBES = 6;
const MAX_PARALLEL_TAB_DISPATCHES = 4;
const bindingMutationLane = new MutationLane();
const tabOperations = new TabOperationQueue();
const contentRuntimeFence = new ContentRuntimeFence();
const promptDispatchGovernor = new PromptDispatchGovernor({
  read: async () => (await chrome.storage.local.get(PROMPT_DISPATCH_GOVERNOR_KEY))[PROMPT_DISPATCH_GOVERNOR_KEY],
  write: async (state) => { await chrome.storage.local.set({ [PROMPT_DISPATCH_GOVERNOR_KEY]: state }); },
});
function serializeBindingMutation<T>(operation: () => Promise<T>): Promise<T> {
  return bindingMutationLane.run(operation);
}

const bindingStore = createBindingStore(
  { local: chrome.storage.local, session: chrome.storage.session },
  { persistent: BINDINGS_KEY, ephemeral: TAB_BINDINGS_KEY },
);


const fleetTabs = new FleetTabRegistry(chrome.storage.session);

async function reconcileAfterRestart(): Promise<void> {
  const state = await workState();
  const active = state.attempts.filter((attempt) =>
    attempt.state === 'prepared' || attempt.state === 'dispatched' || attempt.state === 'acknowledged',
  );
  if (active.length === 0) return;

  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
  const observations = (await mapWithConcurrency(tabs, MAX_PARALLEL_BROWSER_PROBES, recoveryStateForTab)).filter(
    (value): value is AttemptRecoveryObservation => value !== undefined,
  );
  const control = await readNativeControlSnapshot().catch(() => undefined); if (control) for (const observation of observations) { const key = control.agents.find((agent) => agent.browserTabId === observation.tabId)?.conversationKey; if (key) observation.authoritativeConversationKey = key; }
  const byTab = new Map(observations.map((observation) => [observation.tabId, observation]));

  await serializeStateMutation(async () => {
    const current = await readWorkState();
    let attempts = current.attempts;
    let changed = false;
    for (const record of active) {
      const latest = attempts.find((attempt) => attempt.attemptId === record.attemptId);
      if (!latest || latest.state !== record.state) continue;
      const decision = recoverAttempt(latest, byTab.get(latest.tabId));
      if (!decision.nextState) continue;
      const next = advanceAttempt(latest, decision.nextState, Date.now(), decision.error);
      if (next.state === latest.state && next.error === latest.error) continue;
      attempts = retainAttemptLedger([...attempts.filter((attempt) => attempt.attemptId !== next.attemptId), next], current.tasks, current.messages);
      changed = true;
    }
    if (changed) await replaceWorkState(current, { attempts });
  });
}

async function bindingFor(tabId: number, snapshot: ChatSnapshot): Promise<RoleBinding> {
  return serializeBindingMutation(async () => {
    const stores = await bindingStore.read();
    const binding = bindingStore.resolve(tabId, snapshot, stores);
    await bindingStore.persist(stores);
    return binding;
  });
}

async function managedTabs(attempts?: readonly SendAttemptRecord[]): Promise<ManagedTab[]> {
  const [tabs, currentState] = await Promise.all([
    chrome.tabs.query({ url: ['https://chatgpt.com/*'] }),
    attempts ? Promise.resolve(undefined) : workState(),
  ]);
  const candidates = tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined);
  if (candidates.length === 0) return [];
  const ledger = attempts ?? currentState?.attempts ?? [];
  const observed = await mapWithConcurrency(candidates, MAX_PARALLEL_BROWSER_PROBES, async (tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    snapshot: await snapshotForTab(tab),
  }));
  return serializeBindingMutation(async () => {
    const stores = await bindingStore.read();
    const managed = projectManagedTabs(
      observed,
      ledger,
      (tabId, snapshot) => bindingStore.resolve(tabId, snapshot, stores),
    );
    await bindingStore.persist(stores);
    return managed;
  });
}

async function updateBinding(tabId: number, conversationKey: string, binding: RoleBinding): Promise<void> {
  await serializeBindingMutation(() => bindingStore.update(tabId, conversationKey, binding));
}

async function prepareAttempt(
  tabId: number,
  snapshot: ChatSnapshot,
  contentEpoch: string,
  text: string,
  batchId: string,
  taskId?: string,
  messageId?: string,
): Promise<SendAttemptRecord> {
  const now = Date.now();
  const record: SendAttemptRecord = {
    attemptId: crypto.randomUUID(),
    batchId,
    tabId,
    conversationKey: snapshot.conversationKey,
    contentEpoch,
    state: 'prepared',
    textLength: text.length,
    baselineAssistantMessageCount: snapshot.assistantMessageCount,
    createdAt: now,
    updatedAt: now,
  };
  if (snapshot.latestAssistantMessageId) record.baselineAssistantMessageId = snapshot.latestAssistantMessageId;
  if (taskId && messageId) throw new Error('An attempt cannot belong to both a task and a message');
  if (taskId) record.taskId = taskId;
  if (messageId) record.messageId = messageId;

  await serializeStateMutation(async () => {
    const state = await readWorkState();
    let tasks = state.tasks;
    let messages = state.messages;
    if (taskId) {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Task ${taskId} disappeared before dispatch`);
      if (task.retryAfterAttemptId) record.retryOfAttemptId = task.retryAfterAttemptId;
      tasks = state.tasks.map((item) => item.id === taskId
        ? { ...item, attemptIds: [...item.attemptIds, record.attemptId], updatedAt: now }
        : item);
    }
    if (messageId) {
      const message = state.messages.find((item) => item.id === messageId);
      if (!message) throw new Error(`Message ${messageId} disappeared before dispatch`);
      assertMessageDeliveryAvailable(message, state.attempts, snapshot.conversationKey);
      messages = state.messages.map((item) => item.id === messageId
        ? { ...item, attemptIds: [...item.attemptIds, record.attemptId], updatedAt: now }
        : item);
    }
    const attempts = retainAttemptLedger([...state.attempts.filter((item) => item.attemptId !== record.attemptId), record], tasks, messages);
    await replaceWorkState(state, { attempts, tasks, messages });
  });
  return record;
}

function generationReservationKey(tabId: number, binding: RoleBinding): string {
  return binding.agentSlotId ? 'slot:' + binding.agentSlotId : 'tab:' + tabId;
}

async function reconcileGenerationReservation(tabId: number, binding: RoleBinding, snapshot: ChatSnapshot): Promise<void> {
  if (snapshot.status === 'generating' || snapshot.status === 'unknown') return;
  await promptDispatchGovernor.releaseGenerationReservationsForKey(generationReservationKey(tabId, binding));
}

async function dispatchToTabOnce(
  tabId: number,
  text: string,
  batchId: string,
  taskId?: string,
  messageId?: string,
  sharedActiveGenerations?: number,
): Promise<SendResult> {
  let record: SendAttemptRecord | undefined;
  let generationReservationId: string | undefined;
  let physicalWriteRequested = false;
  const fallbackAttemptId = crypto.randomUUID();
  try {
    const tab = await chrome.tabs.get(tabId);
    const recovery = await recoveryStateForTab(tab);
    if (!recovery) throw new Error('Content runtime is unavailable; prompt was not dispatched');
    if (!contentRuntimeFence.observe(tabId, recovery.state.observation, true)) throw new Error('Stale content runtime observation before dispatch');
    const snapshot = recovery.state.snapshot;
    const binding = await reportSlotRuntime(tabId, recovery.state.observation, snapshot, bindingFor);
    await reconcileGenerationReservation(tabId, binding, snapshot);
    if (snapshot.signals.includes('message-rate-limit')) await promptDispatchGovernor.noteRateLimit();
    if (snapshot.status !== 'idle') {
      record = await prepareAttempt(tabId, snapshot, recovery.state.observation.contentEpoch, text, batchId, taskId, messageId);
      const error = `Refusing send while ChatGPT status is ${snapshot.status}`;
      await transitionAttempt(record, 'failed', error);
      return { tabId, attemptId: record.attemptId, ok: false, error };
    }
    const activeGenerations = sharedActiveGenerations !== undefined
      ? sharedActiveGenerations
      : (await readNativeControlSnapshot()).agents.filter((agent) =>
        agent.desiredState === 'active' &&
        agent.browserState === 'open' &&
        agent.browserPageStatus === 'generating',
      ).length;
    const permit = await promptDispatchGovernor.acquire({ project: binding.project, ...(binding.agentSlotId ? { slotId: binding.agentSlotId } : {}), reservationKey: generationReservationKey(tabId, binding), activeGenerations });
    if (!permit.allowed) return { tabId, attemptId: fallbackAttemptId, ok: false, error: `Prompt dispatch deferred by rate governor: ${permit.reason}; retry after ${permit.retryAfterMs}ms` };
    generationReservationId = permit.generationReservationId;
    record = await prepareAttempt(tabId, snapshot, recovery.state.observation.contentEpoch, text, batchId, taskId, messageId);

    const policy = browserOperationPolicy('prompt.send');
    const preconditionsHash = await sha256Text(recovery.state.observation.semanticSignature);
    await planNativeBrowserOperation({
      id: record.attemptId, idempotencyKey: `prompt.send:${record.attemptId}`, operation: policy.operation,
      ...(binding.agentSlotId ? { slotId: binding.agentSlotId } : {}), conversationKey: record.conversationKey,
      tabId, contentEpoch: record.contentEpoch, preconditionsHash, plannedAt: Date.now(),
    });
    record = await transitionAttempt(record, 'dispatched');
    await dispatchNativeBrowserOperation(record.attemptId);

    let response: { ok?: boolean; duplicate?: boolean; error?: string; outcome?: 'proved-not-started' | 'uncertain'; contentEpoch?: string } | undefined;
    try {
      physicalWriteRequested = true;
      response = await chrome.tabs.sendMessage(tabId, { type: 'content:send', text, attemptId: record.attemptId, expectedContentEpoch: record.contentEpoch });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await transitionAttempt(record, 'uncertain', reason);
      await settleNativeBrowserOperation(record.attemptId, 'uncertain', { reason: 'content-transport-error', detail: reason }).catch(() => reportIncident('browser-operation-settle-failed', record!.attemptId, { outcome: 'uncertain', reason }));
      return { tabId, attemptId: record.attemptId, ok: false, error: `Delivery outcome is uncertain: ${reason}` };
    }
    if (!response?.ok) {
      const error = response?.error ?? 'ChatGPT page rejected the send';
      const nextState = response?.outcome === 'proved-not-started' ? 'failed' : 'uncertain';
      await transitionAttempt(record, nextState, error);
      await settleNativeBrowserOperation(record.attemptId, nextState === 'failed' ? 'failed' : 'uncertain', { reason: response?.outcome ?? 'unknown', detail: error }).catch(() => reportIncident('browser-operation-settle-failed', record!.attemptId, { outcome: nextState, error }));
      if (nextState === 'failed' && generationReservationId) await promptDispatchGovernor.releaseGenerationReservation(generationReservationId);
      return { tabId, attemptId: record.attemptId, ok: false, error: nextState === 'uncertain' ? `Delivery outcome is uncertain: ${error}` : error };
    }
    if (response.contentEpoch !== record.contentEpoch) {
      const error = 'Content runtime generation changed while acknowledging the browser effect';
      await transitionAttempt(record, 'uncertain', error);
      await settleNativeBrowserOperation(record.attemptId, 'uncertain', { reason: 'ack-generation-mismatch', returnedContentEpoch: response.contentEpoch ?? null }).catch(() => reportIncident('browser-operation-settle-failed', record!.attemptId, { outcome: 'uncertain', error }));
      return { tabId, attemptId: record.attemptId, ok: false, error };
    }
    await transitionAttempt(record, 'acknowledged');
    await settleNativeBrowserOperation(record.attemptId, 'acknowledged', { duplicate: response.duplicate === true, contentEpoch: response.contentEpoch });
    if (response.duplicate && generationReservationId) await promptDispatchGovernor.releaseGenerationReservation(generationReservationId);
    return { tabId, attemptId: record.attemptId, ok: true, duplicate: response.duplicate === true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (record) {
      const state: SendAttemptState = physicalWriteRequested ? 'uncertain' : 'failed';
      await transitionAttempt(record, state, reason).catch(() => undefined);
      if (!physicalWriteRequested && generationReservationId) await promptDispatchGovernor.releaseGenerationReservation(generationReservationId);

      await settleNativeBrowserOperation(record.attemptId, state === 'uncertain' ? 'uncertain' : 'failed', { reason: 'dispatch-pipeline-error', detail: reason }).catch(() => reportIncident('browser-operation-settle-failed', record!.attemptId, { outcome: state, reason }));
    }
    return { tabId, attemptId: record?.attemptId ?? fallbackAttemptId, ok: false, error: physicalWriteRequested ? `Delivery outcome is uncertain: ${reason}` : reason };
  }
}

async function dispatchToTab(
  tabId: number,
  text: string,
  batchId: string,
  taskId?: string,
  messageId?: string,
  sharedActiveGenerations?: number,
): Promise<SendResult> {
  return tabOperations.run(tabId, () => dispatchToTabOnce(tabId, text, batchId, taskId, messageId, sharedActiveGenerations));
}

async function activeGenerationsForBatch(): Promise<number | undefined> {
  try {
    const control = await readNativeControlSnapshot();
    return control.agents.filter((agent) =>
      agent.desiredState === 'active' &&
      agent.browserState === 'open' &&
      agent.browserPageStatus === 'generating',
    ).length;
  } catch {
    return undefined;
  }
}

async function sendToTabs(tabIds: number[], text: string): Promise<SendResult[]> {
  const batchId = crypto.randomUUID();
  const uniqueTabIds = [...new Set(tabIds)];
  const activeGenerations = activeGenerationsForBatch();
  // Each tab is independently serialized by TabOperationQueue; dispatching the
  // independent lanes together removes avoidable cross-tab latency while keeping
  // same-tab writes and their uncertain outcomes strictly ordered.
  return mapWithConcurrency(uniqueTabIds, MAX_PARALLEL_TAB_DISPATCHES, async (tabId) =>
    dispatchToTab(tabId, text, batchId, undefined, undefined, await activeGenerations),
  );
}

async function createTask(input: CreateTaskInput): Promise<AgentTask> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const now = Date.now();
    const task: AgentTask = {
      id: crypto.randomUUID(),
      kind: input.kind,
      completionPolicy: input.completionPolicy ?? defaultCompletionPolicy(input.kind),
      title: input.title.trim(),
      project: input.project.trim(),
      instruction: input.instruction.trim(),
      targetRole: input.kind === 'human' ? '' : input.targetRole.trim(),
      dependsOn: [...new Set(input.dependsOn.map((id) => id.trim()).filter(Boolean))],
      attemptIds: [],
      createdAt: now,
      updatedAt: now,
    };
    if (input.kind === 'review') {
      if (input.reviewTargetTaskId) task.reviewTargetTaskId = input.reviewTargetTaskId.trim();
      task.maxReviewRounds = input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
    }
    const tasks = [...state.tasks, task];
    validateTaskGraph(tasks);
    await replaceWorkState(state, { tasks });
    return task;
  });
}

async function createMessage(input: import('./contracts').CreateAgentMessageInput): Promise<AgentMessage> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const message = createAgentMessage(input, crypto.randomUUID());
    const messages = [...state.messages, message];
    await replaceWorkState(state, { messages });
    return message;
  });
}

async function freezeMessageRecipients(
  messageId: string,
  recipientConversationKeys: readonly string[],
): Promise<AgentMessage> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const current = state.messages.find((item) => item.id === messageId);
    if (!current) throw new Error(`Message ${messageId} disappeared before recipient freeze`);
    if (current.recipientConversationKeys) return current;
    if (recipientConversationKeys.length === 0) throw new Error('Cannot freeze an empty recipient set');
    const updated: AgentMessage = {
      ...current,
      recipientConversationKeys: [...recipientConversationKeys],
      updatedAt: Date.now(),
    };
    const messages = state.messages.map((item) => item.id === messageId ? updated : item);
    await replaceWorkState(state, { messages });
    return updated;
  });
}

async function dispatchMessage(messageId: string): Promise<SendResult[]> {
  let state = await workState();
  let message = state.messages.find((item) => item.id === messageId);
  if (!message) throw new Error(`Message ${messageId} does not exist`);
  let tabs = await managedTabs(state.attempts);
  let plan = planMessageDispatch(message, state.attempts, tabs);
  if (plan.error) throw new Error(plan.error);

  if (!message.recipientConversationKeys) {
    if (!plan.recipientConversationKeys?.length) throw new Error('Message recipient discovery produced no recipients');
    message = await freezeMessageRecipients(message.id, plan.recipientConversationKeys);
    state = await workState();
    tabs = await managedTabs(state.attempts);
    plan = planMessageDispatch(message, state.attempts, tabs);
    if (plan.error) throw new Error(plan.error);
  }

  if (plan.tabIds.length === 0) return [];
  const prompt = buildSemanticMessagePrompt(message);
  const batchId = crypto.randomUUID();
  const activeGenerations = activeGenerationsForBatch();
  return Promise.all(plan.tabIds.map(async (tabId) =>
    dispatchToTab(tabId, prompt, batchId, undefined, message.id, await activeGenerations),
  ));
}

async function requestTaskRetry(taskId: string): Promise<AgentTask> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} does not exist`);
    const lastAttemptId = task.attemptIds.at(-1);
    if (!lastAttemptId) throw new Error('Task has no failed or uncertain attempt to retry');
    const lastAttempt = state.attempts.find((attempt) => attempt.attemptId === lastAttemptId);
    if (!isRetryableTaskAttempt(task, lastAttempt)) {
      throw new Error('This task does not have a retryable failed, uncertain, or protocol-invalid structured/review attempt');
    }
    if (task.kind === 'review' && lastAttempt?.state === 'reply-observed') {
      const parsed = parseReviewResult(lastAttempt.replyTextTail ?? '');
      if (parsed.ok && parsed.result.decision === 'fail') {
        throw new Error('A failed review must use the bounded revise-and-re-review action');
      }
    }
    const updated: AgentTask = { ...task, retryAfterAttemptId: lastAttemptId, updatedAt: Date.now() };
    const tasks = state.tasks.map((item) => item.id === taskId ? updated : item);
    await replaceWorkState(state, { tasks });
    return updated;
  });
}
async function setTaskDisposition(taskId: string, action: 'skip' | 'cancel', reason = ''): Promise<AgentTask> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const managed = deriveManagedTasks(state.tasks, state.attempts).find((item) => item.task.id === taskId);
    if (!managed) throw new Error(`Task ${taskId} does not exist`);
    const updated = applyTaskDisposition(managed.task, managed.status, action, Date.now(), reason);
    const tasks = state.tasks.map((task) => task.id === taskId ? updated : task);
    await replaceWorkState(state, { tasks });
    return updated;
  });
}

async function decideHumanTask(taskId: string, decision: 'approve' | 'reject', reason = ''): Promise<AgentTask> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const managed = deriveManagedTasks(state.tasks, state.attempts).find((item) => item.task.id === taskId);
    if (!managed) throw new Error(`Task ${taskId} does not exist`);
    const updated = applyHumanDecision(managed.task, managed.status, decision, Date.now(), reason);
    const tasks = state.tasks.map((task) => task.id === taskId ? updated : task);
    await replaceWorkState(state, { tasks });
    return updated;
  });
}

async function retryReviewLoop(taskId: string): Promise<{ reviewTask: AgentTask; targetTask: AgentTask }> {
  return serializeStateMutation(async () => {
    const state = await readWorkState();
    const reviewTask = state.tasks.find((task) => task.id === taskId);
    if (!reviewTask || reviewTask.kind !== 'review' || !reviewTask.reviewTargetTaskId) throw new Error(`Review task ${taskId} does not have a review target`);
    const targetTask = state.tasks.find((task) => task.id === reviewTask.reviewTargetTaskId);
    if (!targetTask) throw new Error(`Review target ${reviewTask.reviewTargetTaskId} does not exist`);
    const reviewAttemptId = reviewTask.attemptIds.at(-1);
    const targetAttemptId = targetTask.attemptIds.at(-1);
    const reviewAttempt = reviewAttemptId ? state.attempts.find((attempt) => attempt.attemptId === reviewAttemptId) : undefined;
    const targetAttempt = targetAttemptId ? state.attempts.find((attempt) => attempt.attemptId === targetAttemptId) : undefined;
    if (!reviewAttempt || !targetAttempt) throw new Error('Review loop is missing attempt evidence');
    const updated = applyReviewRemediation(reviewTask, targetTask, reviewAttempt, targetAttempt);
    const tasks = state.tasks.map((task) => task.id === updated.reviewTask.id ? updated.reviewTask : task.id === updated.targetTask.id ? updated.targetTask : task);
    validateTaskGraph(tasks);
    await replaceWorkState(state, { tasks });
    return updated;
  });
}

async function exportStateDocument(): Promise<string> {
  const [bindings, state, enabled] = await Promise.all([bindingStore.readPersistent(), workState(), supervisorEnabled()]);
  return stringifyPortableManagerState(createPortableManagerState(bindings, state.tasks, state.attempts, state.messages, enabled));
}

async function importStateDocument(document: string): Promise<void> {
  const imported = parsePortableManagerState(document);
  await serializeBindingMutation(async () => {
    await serializeStateMutation(async () => {
      const current = await readWorkState();
      await replaceWorkState(current, {
        tasks: imported.tasks,
        attempts: restorePortableAttempts(imported.attempts),
        messages: imported.messages,
      });
      await chrome.storage.local.set({ [BINDINGS_KEY]: imported.bindings, [SUPERVISOR_KEY]: imported.supervisorEnabled });
      await chrome.storage.local.remove([TASKS_KEY, SEND_ATTEMPTS_KEY, MESSAGES_KEY]);
      await chrome.storage.session.remove(TAB_BINDINGS_KEY);
    });
  });
}

async function migrateLegacyWorkStateOnce(): Promise<void> {
  const kernel = await readNativeWorkSnapshot();
  const stored = await chrome.storage.local.get([TASKS_KEY, SEND_ATTEMPTS_KEY, MESSAGES_KEY]);
  const tasks = Array.isArray(stored[TASKS_KEY]) ? (stored[TASKS_KEY] as AgentTask[]).map(normalizeTask) : [];
  const attempts = Array.isArray(stored[SEND_ATTEMPTS_KEY]) ? restorePortableAttempts(stored[SEND_ATTEMPTS_KEY] as SendAttemptRecord[]) : [];
  const messages = Array.isArray(stored[MESSAGES_KEY]) ? stored[MESSAGES_KEY] as AgentMessage[] : [];
  if (kernel.revision === 0 && (tasks.length || attempts.length || messages.length)) {
    await replaceNativeWorkState({ revision: 0, tasks, attempts, messages });
  }
  await chrome.storage.local.remove([TASKS_KEY, SEND_ATTEMPTS_KEY, MESSAGES_KEY]);
}

async function supervisorEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(SUPERVISOR_KEY);
  return stored[SUPERVISOR_KEY] === true;
}

async function setSupervisorEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [SUPERVISOR_KEY]: enabled });
}

async function runReadyTasks(): Promise<TaskDispatchResult[]> {
  const state = await workState();
  validateTaskGraph(state.tasks);
  const tasks = deriveManagedTasks(state.tasks, state.attempts);
  const tabs = await managedTabs(state.attempts);
  const [controlSnapshot, mapping] = await Promise.all([readNativeControlSnapshot(), fleetTabs.read()]);
  return dispatchReadyManagedTasks(tasks, tabs, controlSnapshot, mapping, crypto.randomUUID(), dispatchToTab);
}

const supervisorRunner = new CoalescingRunner(async () => {
  if (!await supervisorEnabled()) return;
  await runReadyTasks();
  await notifyManagerChanged();
}, (error) => {
  void reportIncident('supervisor-run-failed', 'auto-supervisor', { error: error instanceof Error ? error.message : String(error) });
});

function kickSupervisor(): void {
  supervisorRunner.kick();
}
async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

let browserReportTimer: number | undefined;

async function reportBrowserRuntimeFromTabs(tabs: ManagedTab[]): Promise<void> {
  const runtime = deriveBrowserRuntimeObservation(tabs.map((tab) => tab.snapshot.status));
  await reportNativeBrowserRuntime({
    profileId: 'gam-default',
    authStatus: runtime.authStatus,
    pageHealth: runtime.pageHealth,
    openTabs: tabs.length,
    extensionVersion: chrome.runtime.getManifest().version,
    observedAt: Date.now(),
  });
}

const browserRuntimeReportRunner = new CoalescingRunner(async () => {
  const state = await workState();
  const tabs = await managedTabs(state.attempts);
  await reportBrowserRuntimeFromTabs(tabs);
}, (error) => {
  void reportIncident('browser-runtime-report-failed', 'gam-default', { error: error instanceof Error ? error.message : String(error) });
});

function scheduleBrowserRuntimeReport(): void {
  if (browserReportTimer !== undefined) clearTimeout(browserReportTimer);
  browserReportTimer = setTimeout(() => {
    browserReportTimer = undefined;
    browserRuntimeReportRunner.kick();
  }, 250) as unknown as number;
}
let fleetReconcileTimer: number | undefined;

async function clearFleetBinding(conversationKey: string | undefined, tabId: number | undefined): Promise<void> {
  await serializeBindingMutation(() => bindingStore.clear(conversationKey, tabId));
}

async function syncWorkerRequestMessages(snapshot: import('./nativeControl').NativeControlSnapshot): Promise<void> {
  await serializeStateMutation(async () => {
    const state = await readWorkState();
    const existing = new Set(state.messages.map((message) => message.id));
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const created: AgentMessage[] = [];
    for (const request of snapshot.workerRequests) {
      if (request.status !== 'open') continue;
      const messageId = CONTROL_REQUEST_MESSAGE_PREFIX + request.id;
      if (existing.has(messageId)) continue;
      const project = projects.get(request.projectId);
      if (!project) continue;
      const supervisors = snapshot.agents.filter((agent) =>
        agent.projectId === request.projectId && agent.desiredState === 'active' &&
        agent.role.trim().toUpperCase() === 'SUPERVISOR',
      );
      if (supervisors.length !== 1) continue;
      const supervisor = supervisors[0];
      if (!supervisor) continue;
      const senderRole = agents.get(request.fromSubject)?.role ?? request.fromSubject;
      created.push(workerRequestMessage(request, project.name, senderRole, supervisor.role));
    }
    const feedback = controlFeedbackMessages(snapshot, new Set([...existing, ...created.map((message) => message.id)]));
    if (created.length || feedback.length) {
      await replaceWorkState(state, { messages: [...state.messages, ...created, ...feedback] });
    }
  });
}

async function deliverWorkerRequestMessages(snapshot: import('./nativeControl').NativeControlSnapshot): Promise<void> {
  await syncWorkerRequestMessages(snapshot);
  const openIds = new Set([
    ...snapshot.workerRequests
      .filter((request) => request.status === 'open')
      .map((request) => CONTROL_REQUEST_MESSAGE_PREFIX + request.id),
    ...controlFeedbackMessages(snapshot).map((message) => message.id),
  ]);
  const state = await workState();
  for (const message of state.messages) {
    if (!openIds.has(message.id)) continue;
    try {
      await dispatchMessage(message.id);
    } catch {
      // Busy/missing/uncertain delivery is retried or held by the existing message ledger.
    }
  }
}

async function reconcileAgentFleetOnce(): Promise<void> {
  return fleetTabs.run(async () => {
    await reconcileNativeElasticFleet();
    const snapshot = await readNativeControlSnapshot();
    const state = await workState();
    const currentTabs = await managedTabs(state.attempts);
    const mapping = await fleetTabs.read();
    const actions = planFleetReconciliation(snapshot.agents, currentTabs, mapping);
    const latestRuntime = [...snapshot.browserRuntime].sort((a, b) => b.observedAt - a.observedAt)[0];
    const currentRuntime = deriveBrowserRuntimeObservation(currentTabs.map((tab) => tab.snapshot.status));
    const expansionAllowed = fleetExpansionAllowed(currentRuntime, latestRuntime, Date.now());
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    for (const action of actions) {
      const agent = agents.get(action.slotId); if (!agent) continue;
      const project = projects.get(agent.projectId); if (!project) continue;
      try {
      if (action.kind === 'open') {
        if (!expansionAllowed) {
          if (agent.browserState !== 'absent') {
            delete mapping[agent.id]; await fleetTabs.write(mapping);
            await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'absent', observedAt: Date.now() });
          }
          continue;
        }
        const tab = await chrome.tabs.create({ url: action.url, active: false });
        if (tab.id === undefined) throw new Error(`Chrome did not return a tab id for agent slot ${agent.id}`);
        mapping[agent.id] = tab.id; await fleetTabs.write(mapping);
        const key = agent.conversationKey ?? `url:${action.url}`;
        await updateBinding(tab.id, key, { role: agent.role, project: project.name, notes: `GAM fleet slot ${agent.id}`, agentSlotId: agent.id });
        await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'opening', tabId: tab.id, observedAt: Date.now() });
      } else if (action.kind === 'rollover-start') {
        await beginNativeAgentRollover(agent.id, action.rolloverId); scheduleFleetReconcile(0);
      } else if (action.kind === 'rollover-close') {
        await tabOperations.run(action.tabId, async () => { await beginNativeAgentRollover(agent.id, action.rolloverId); await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'closing', tabId: action.tabId, observedAt: Date.now() }); await clearFleetBinding(agent.conversationKey, action.tabId); try { await chrome.tabs.remove(action.tabId); } catch (error) { await reportIncident('fleet-tab-close-failed', agent.id, { tabId: action.tabId, error: error instanceof Error ? error.message : String(error) }); } delete mapping[agent.id]; await fleetTabs.write(mapping); await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'absent', observedAt: Date.now() }); });
      } else if (action.kind === 'close') {
        await tabOperations.run(action.tabId, async () => {
        await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'closing', tabId: action.tabId, observedAt: Date.now() });
        await clearFleetBinding(agent.conversationKey, action.tabId);
        try { await chrome.tabs.remove(action.tabId); } catch (error) { await reportIncident('fleet-tab-close-failed', agent.id, { tabId: action.tabId, error: error instanceof Error ? error.message : String(error) }); }
        delete mapping[agent.id]; await fleetTabs.write(mapping);
        await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'absent', observedAt: Date.now() });
        });
      } else if (action.kind === 'report-open') {
        mapping[agent.id] = action.tabId; await fleetTabs.write(mapping);
        const tab = currentTabs.find((item) => item.tabId === action.tabId);
        if (tab && (tab.binding.agentSlotId !== agent.id || tab.binding.role !== agent.role || tab.binding.project !== project.name)) {
          await updateBinding(tab.tabId, action.conversationKey ?? tab.snapshot.conversationKey, { role: agent.role, project: project.name, notes: `GAM fleet slot ${agent.id}`, agentSlotId: agent.id });
        }
        await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'open', tabId: action.tabId, ...(action.conversationKey ? { conversationKey: action.conversationKey } : {}), observedAt: Date.now() });
      } else {
        delete mapping[agent.id]; await fleetTabs.write(mapping);
        await reportNativeAgentBrowser({ slotId: agent.id, profileId: 'gam-default', browserState: 'absent', observedAt: Date.now() });
      }
      } catch (error) {
        await reportIncident('fleet-action-failed', action.slotId, { kind: action.kind, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await deliverWorkerRequestMessages(snapshot);
    // Fleet bindings may become usable only after the content event that triggered this reconcile.
    // Give Auto Supervisor a second scheduling opportunity against the reconciled binding state.
    kickSupervisor();
    void dispatchOrganizationTasks();
  });
}
let organizationRetryTimer: number | undefined;
function retryOrganizationExecution(): void { if (organizationRetryTimer !== undefined) return; organizationRetryTimer = setTimeout(() => { organizationRetryTimer = undefined; scheduleFleetReconcile(0); }, 1000) as unknown as number; }
async function dispatchOrganizationTasks(): Promise<void> { const tasks = (await workState()).tasks; if (!hasOrganizationExecutionTask(tasks)) return; if (markOrganizationExecutionObserved(tasks)) void reportIncident('organization-auto-dispatch-observed', 'organization-runtime', {}); const results = await runReadyTasks(); if (results.some((result) => !result.ok)) retryOrganizationExecution(); }
const fleetReconcileRunner = new CoalescingRunner(reconcileAgentFleetOnce, (error) => {
  void reportIncident('fleet-reconcile-failed', 'fleet-runtime', { error: error instanceof Error ? error.message : String(error) });
});
function scheduleFleetReconcile(delayMs = 150): void {
  if (fleetReconcileTimer !== undefined) clearTimeout(fleetReconcileTimer);
  fleetReconcileTimer = setTimeout(() => { fleetReconcileTimer = undefined; fleetReconcileRunner.kick(); }, delayMs) as unknown as number;
}
async function closeOrphanBlankTabs(): Promise<void> { const tabs = await chrome.tabs.query({ url: 'about:blank' }); await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [chrome.tabs.remove(tab.id).catch(() => undefined)])); }

async function notifyManagerChanged(): Promise<void> {
  const notice: RuntimeNotice = { type: 'manager:changed' };
  try { await chrome.runtime.sendMessage(notice); } catch { /* no side panel open */ }
}

chrome.runtime.onMessage.addListener((message: ManagerRequest | RuntimeNotice, sender, sendResponse) => {
  if (message.type === 'content:changed') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !contentRuntimeFence.observe(tabId, message.observation)) return false;
    void reportSlotRuntime(tabId, message.observation, message.snapshot, bindingFor)
      .then(async (binding) => { await reconcileGenerationReservation(tabId, binding, message.snapshot); scheduleFleetReconcile(0); await requestAutomaticConversationRollover(tabId, binding, message.snapshot); await bootstrapPendingConversationRollover(tabId, binding, message.snapshot, (id, text) => dispatchToTab(id, text, crypto.randomUUID())); const bootstrapAttempt = await bootstrapReplyAttemptId(binding, message.snapshot); if (bootstrapAttempt) { const persisted = await markReplyObserved(bootstrapAttempt, message.observation.contentEpoch, message.snapshot, tabId); if (persisted) await completeConversationRolloverForReply(binding, bootstrapAttempt); } })
      .catch((error) => reportIncident('agent-runtime-report-failed', String(tabId), { error: error instanceof Error ? error.message : String(error), contentEpoch: message.observation.contentEpoch }));
    void notifyManagerChanged();
    scheduleBrowserRuntimeReport(); scheduleFleetReconcile();
    if (message.snapshot.status === 'idle') void dispatchOrganizationTasks().then(() => scheduleFleetReconcile(0)).catch((error) => reportIncident('organization-auto-dispatch-failed', 'organization-runtime', { error: error instanceof Error ? error.message : String(error) }));
    kickSupervisor();
    return false;
  }
  if (message.type === 'content:reply-observed') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !contentRuntimeFence.observe(tabId, message.observation, true)) {
      sendResponse({ ok: false, error: 'Stale content runtime observation' });
      return false;
    }
    void reportSlotRuntime(tabId, message.observation, message.snapshot, bindingFor)
      .then(async (binding) => { await reconcileGenerationReservation(tabId, binding, message.snapshot); const persisted = await markReplyObserved(message.attemptId, message.observation.contentEpoch, message.snapshot, tabId); if (persisted) await completeConversationRolloverForReply(binding, message.attemptId); return persisted; })
      .then(async (persisted) => {
        if (persisted) {
          await notifyManagerChanged();
          kickSupervisor();
        }
        sendResponse({ ok: persisted });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:list') {
    void (async () => {
      const state = await workState();
      validateTaskGraph(state.tasks);
      const [tabs, tasks] = await Promise.all([
        managedTabs(state.attempts),
        Promise.resolve(deriveManagedTasks(state.tasks, state.attempts)),
      ]);
      const attemptsById = new Map(state.attempts.map((attempt) => [attempt.attemptId, attempt]));
      const messages = state.messages.map((message) => ({
        message,
        attemptHistory: message.attemptIds.map((id) => attemptsById.get(id)).filter(Boolean),
      }));
      void reportBrowserRuntimeFromTabs(tabs).catch((error) => reportIncident('browser-runtime-report-failed', 'gam-default', { error: error instanceof Error ? error.message : String(error) }));
      sendResponse({ ok: true, tabs, tasks, messages, supervisorEnabled: await supervisorEnabled() });
    })().catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:update-binding') {
    void updateBinding(message.tabId, message.conversationKey, message.binding)
      .then(() => notifyManagerChanged())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:send') {
    void sendToTabs(message.tabIds, message.text).then(async (results) => {
      await notifyManagerChanged();
      sendResponse({ ok: true, results });
    }).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:create-task') {
    void createTask(message.input)
      .then(async (task) => { await notifyManagerChanged(); scheduleFleetReconcile(0); kickSupervisor(); sendResponse({ ok: true, task }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:create-message') {
    void createMessage(message.input)
      .then(async (created) => { await notifyManagerChanged(); sendResponse({ ok: true, message: created }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:dispatch-message') {
    void dispatchMessage(message.messageId)
      .then(async (results) => { await notifyManagerChanged(); sendResponse({ ok: true, results }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:run-ready-tasks') {
    void runReadyTasks()
      .then(async (results) => { await notifyManagerChanged(); scheduleFleetReconcile(0); sendResponse({ ok: true, results }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }  if (message.type === 'manager:retry-task') {
    void requestTaskRetry(message.taskId)
      .then(async (task) => { await notifyManagerChanged(); scheduleFleetReconcile(0); kickSupervisor(); sendResponse({ ok: true, task }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }  if (message.type === 'manager:retry-review-loop') {
    void retryReviewLoop(message.taskId)
      .then(async (updated) => { await notifyManagerChanged(); scheduleFleetReconcile(0); kickSupervisor(); sendResponse({ ok: true, ...updated }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:decide-human-task') {
    void decideHumanTask(message.taskId, message.decision, message.reason ?? '')
      .then(async (task) => { await notifyManagerChanged(); scheduleFleetReconcile(0); kickSupervisor(); sendResponse({ ok: true, task }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:skip-task') {
    void setTaskDisposition(message.taskId, 'skip', message.reason ?? '')
      .then(async (task) => { await notifyManagerChanged(); scheduleFleetReconcile(0); kickSupervisor(); sendResponse({ ok: true, task }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:cancel-task') {
    void setTaskDisposition(message.taskId, 'cancel', message.reason ?? '')
      .then(async (task) => { await notifyManagerChanged(); scheduleFleetReconcile(0); kickSupervisor(); sendResponse({ ok: true, task }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:control-snapshot') {
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Native control requests are only accepted from extension UI contexts' });
      return false;
    }
    void readNativeControlSnapshot()
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:export-state') {
    void exportStateDocument()
      .then((document) => sendResponse({ ok: true, document }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:import-state') {
    void importStateDocument(message.document)
      .then(async () => { await notifyManagerChanged(); scheduleFleetReconcile(0); if (await supervisorEnabled()) kickSupervisor(); sendResponse({ ok: true }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:set-supervisor-enabled') {
    void setSupervisorEnabled(message.enabled)
      .then(async () => { await notifyManagerChanged(); if (message.enabled) kickSupervisor(); sendResponse({ ok: true }); })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === 'manager:focus') {
    void focusTab(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => reportIncident('side-panel-configuration-failed', 'extension', { error: String(error) }));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.url?.startsWith('https://chatgpt.com/') && (changeInfo.status === 'complete' || changeInfo.url !== undefined)) {
    void notifyManagerChanged();
    scheduleBrowserRuntimeReport(); scheduleFleetReconcile(); void dispatchOrganizationTasks().then(() => scheduleFleetReconcile(0)).catch((error) => reportIncident('organization-auto-dispatch-failed', 'organization-runtime', { error: error instanceof Error ? error.message : String(error) }));
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  contentRuntimeFence.remove(tabId);
  void fleetTabs.run(async () => {
    const [mapping, bindingChanged] = await Promise.all([
      fleetTabs.read(),
      serializeBindingMutation(async () => {
        const bindings = await bindingStore.readEphemeral();
        if (bindings[String(tabId)] === undefined) return false;
        delete bindings[String(tabId)];
        await bindingStore.writeEphemeral(bindings);
        return true;
      }),
    ]);
    let mappingChanged = false;
    for (const [slotId, mappedTabId] of Object.entries(mapping)) {
      if (mappedTabId === tabId) { delete mapping[slotId]; mappingChanged = true; }
    }
    if (mappingChanged) await fleetTabs.write(mapping);
    await notifyManagerChanged();
    scheduleFleetReconcile(0);
  }).catch((error) => reportIncident('tab-removal-reconciliation-failed', String(tabId), { error: error instanceof Error ? error.message : String(error) }));
});

void migrateLegacyWorkStateOnce().then(() => reconcileAfterRestart()).then(() => {
  void notifyManagerChanged();
  kickSupervisor();
  scheduleFleetReconcile(0);
}).catch((error) => {
  void reportIncident('restart-reconciliation-failed', 'service-worker', { error: error instanceof Error ? error.message : String(error) }, 'critical');
});
const FLEET_RECONCILE_ALARM = 'gam:fleet-reconcile'; const ORGANIZATION_DISPATCH_ALARM = 'gam:organization-dispatch';
async function ensureAutomationAlarms(): Promise<void> {
  const alarms = await Promise.all([chrome.alarms.get(FLEET_RECONCILE_ALARM), chrome.alarms.get(ORGANIZATION_DISPATCH_ALARM)]);
  if (!alarms[0]) await chrome.alarms.create(FLEET_RECONCILE_ALARM, { periodInMinutes: 1 }); if (!alarms[1]) await chrome.alarms.create(ORGANIZATION_DISPATCH_ALARM, { periodInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FLEET_RECONCILE_ALARM && alarm.name !== ORGANIZATION_DISPATCH_ALARM) return;
  scheduleBrowserRuntimeReport();
  scheduleFleetReconcile(0);
  void dispatchOrganizationTasks().catch((error) => reportIncident('organization-auto-dispatch-failed', 'organization-runtime', { error: error instanceof Error ? error.message : String(error) }));
});
chrome.runtime.onInstalled.addListener(() => { void ensureAutomationAlarms().catch((error) => reportIncident('automation-alarm-configuration-failed', 'extension', { error: String(error) })); scheduleBrowserRuntimeReport(); scheduleFleetReconcile(0); });
chrome.runtime.onStartup.addListener(() => { void ensureAutomationAlarms().catch((error) => reportIncident('automation-alarm-configuration-failed', 'extension', { error: String(error) })); scheduleBrowserRuntimeReport(); scheduleFleetReconcile(0); });
void reportBrowserRuntimeFromTabs([]).catch((error) => reportIncident('browser-runtime-report-failed', 'startup', { error: error instanceof Error ? error.message : String(error) }));
scheduleBrowserRuntimeReport();
void ensureAutomationAlarms().catch((error) => reportIncident('automation-alarm-configuration-failed', 'extension', { error: String(error) })); void closeOrphanBlankTabs().catch((error) => reportIncident('orphan-blank-tab-cleanup-failed', 'extension', { error: String(error) })); void dispatchOrganizationTasks().catch((error) => reportIncident('organization-auto-dispatch-failed', 'organization-runtime', { error: error instanceof Error ? error.message : String(error) }));
