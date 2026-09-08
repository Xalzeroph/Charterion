import type { AgentMessage, ManagedTab } from './contracts';
import type { ControlAgentView, ControlWorkerRequestView } from './nativeControl';
import { RUNTIME_POLICY } from './runtimePolicy';

export type FleetAction =
  | { kind: 'open'; slotId: string; url: string }
  | { kind: 'close'; slotId: string; tabId: number }
  | { kind: 'rollover-start'; slotId: string; rolloverId: string }
  | { kind: 'rollover-close'; slotId: string; rolloverId: string; tabId: number }
  | { kind: 'report-open'; slotId: string; tabId: number; conversationKey?: string }
  | { kind: 'report-absent'; slotId: string };

export function agentConversationUrl(conversationKey?: string): string {
  if (!conversationKey?.startsWith('conversation:')) return 'https://chatgpt.com/';
  const id = conversationKey.slice('conversation:'.length);
  if (!id || id === 'new' || /^WEB:/i.test(id)) return 'https://chatgpt.com/';
  return `https://chatgpt.com/c/${encodeURIComponent(id)}`;
}

interface FleetTabIndex {
  byAgentSlotId: Map<string, ManagedTab[]>;
  byTabId: Map<number, ManagedTab>;
}

function indexFleetTabs(tabs: readonly ManagedTab[]): FleetTabIndex {
  const byAgentSlotId = new Map<string, ManagedTab[]>();
  const byTabId = new Map<number, ManagedTab>();
  for (const tab of tabs) {
    if (!byTabId.has(tab.tabId)) byTabId.set(tab.tabId, tab);
    const agentSlotId = tab.binding.agentSlotId;
    if (!agentSlotId) continue;
    const owned = byAgentSlotId.get(agentSlotId);
    if (owned) owned.push(tab);
    else byAgentSlotId.set(agentSlotId, [tab]);
  }
  return { byAgentSlotId, byTabId };
}

function ownedTabForAgent(agent: ControlAgentView, index: FleetTabIndex, mappedTabId?: number): ManagedTab | undefined {
  const owned = index.byAgentSlotId.get(agent.id) ?? [];
  if (mappedTabId !== undefined) {
    const mapped = owned.find((tab) => tab.tabId === mappedTabId);
    if (mapped) return mapped;
  }
  if (owned.length === 1) return owned[0];
  return undefined;
}

function reconciliationTabForAgent(agent: ControlAgentView, index: FleetTabIndex, mappedTabId?: number): ManagedTab | undefined {
  const owned = ownedTabForAgent(agent, index, mappedTabId);
  if (owned) return owned;
  const reservedTabId = mappedTabId ?? agent.browserTabId;
  if (reservedTabId === undefined || agent.browserTabId !== reservedTabId || !agent.browserLeaseId ||
      !['opening', 'open'].includes(agent.browserState)) return undefined;
  const reserved = index.byTabId.get(reservedTabId);
  return reserved && !reserved.binding.agentSlotId ? reserved : undefined;
}
export function planFleetReconciliation(
  agents: readonly ControlAgentView[],
  tabs: readonly ManagedTab[],
  mappedTabs: Readonly<Record<string, number>>,
  now = Date.now(),
  openingGraceMs = 30_000,
): FleetAction[] {
  const actions: FleetAction[] = [];
  const tabIndex = indexFleetTabs(tabs);
  for (const agent of agents) {
    const tab = reconciliationTabForAgent(agent, tabIndex, mappedTabs[agent.id]);
    if (agent.desiredState === 'active' && agent.rolloverState === 'requested') {
      if (!agent.activeRolloverId) throw new Error(`AgentSlot ${agent.id} requested rollover without an id`);
      if (tab && tab.snapshot.status !== 'generating') actions.push({ kind: 'rollover-close', slotId: agent.id, rolloverId: agent.activeRolloverId, tabId: tab.tabId });
      else if (!tab && agent.browserState === 'absent') actions.push({ kind: 'rollover-start', slotId: agent.id, rolloverId: agent.activeRolloverId });
      else if (!tab && agent.browserState !== 'absent') actions.push({ kind: 'report-absent', slotId: agent.id });
      continue;
    }
    if (agent.desiredState === 'active') {
      if (!tab) {
        const reservedTabId = mappedTabs[agent.id] ?? agent.browserTabId;
        if (agent.browserState === 'opening' && reservedTabId !== undefined &&
            (agent.browserObservedAt === undefined || now - agent.browserObservedAt <= openingGraceMs)) continue;
        if (agent.browserState !== 'absent') { actions.push({ kind: 'report-absent', slotId: agent.id }); continue; }
        actions.push({ kind: 'open', slotId: agent.id, url: agentConversationUrl(agent.conversationKey) });
        continue;
      }
      const conversationKey = tab.snapshot.conversationKey.startsWith('conversation:')
        ? tab.snapshot.conversationKey
        : undefined;
      actions.push({ kind: 'report-open', slotId: agent.id, tabId: tab.tabId, ...(conversationKey ? { conversationKey } : {}) });
      continue;
    }
    if (tab && tab.snapshot.status !== 'generating') actions.push({ kind: 'close', slotId: agent.id, tabId: tab.tabId });
    else if (!tab && agent.browserState !== 'absent') actions.push({ kind: 'report-absent', slotId: agent.id });
  }
  return actions;
}

export function filterFleetTaskTabs(
  tabs: readonly ManagedTab[],
  agents: readonly ControlAgentView[],
  mappedTabs: Readonly<Record<string, number>>,
): ManagedTab[] {
  const allowed = new Set<number>();
  const tabIndex = indexFleetTabs(tabs);
  for (const agent of agents) {
    if (agent.desiredState !== 'active' || agent.browserQuarantined || agent.rolloverState !== 'idle') continue;
    const tab = ownedTabForAgent(agent, tabIndex, mappedTabs[agent.id]);
    if (tab) allowed.add(tab.tabId);
  }
  return tabs.filter((tab) => allowed.has(tab.tabId));
}

export function workerRequestMessage(
  request: ControlWorkerRequestView,
  projectName: string,
  fromRole: string,
  supervisorRole: string,
): AgentMessage {
  const type: AgentMessage['type'] = request.type === 'blocker'
    ? 'blocker'
    : request.type === 'question'
      ? 'question'
      : request.type === 'review-request'
        ? 'review-request'
        : 'announcement';
  const content = [
    `Request ID: ${request.id}`,
    `Type: ${request.type}`,
    `Title: ${request.title}`,
    '', request.body,
    ...(request.suggestedAction ? ['', `Suggested action: ${request.suggestedAction}`] : []),
    '', 'Inspect the relevant project state, then accept or reject this request through the GAM Kernel.',
  ].join('\n');
  const message: AgentMessage = {
    id: `${RUNTIME_POLICY.controlRequestMessagePrefix}${request.id}`,
    project: projectName,
    fromRole,
    target: { kind: 'role', role: supervisorRole },
    type,
    content,
    attemptIds: [],
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
  if (request.taskId) message.taskId = request.taskId;
  return message;
}
