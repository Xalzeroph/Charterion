import { roleMatchScore } from '../shared/agentRole';
import type { AgentTask, ManagedTab, ManagedTask } from './contracts';

export interface DispatchDecision {
  taskId: string;
  tabId?: number;
  error?: string;
}

function attemptAllowsDispatch(task: AgentTask, tab: ManagedTab): boolean {
  const last = tab.lastAttempt;
  if (!last) return true;
  if (last.state === 'prepared' || last.state === 'dispatched' || last.state === 'acknowledged') return false;
  if (last.state === 'uncertain') return task.retryAfterAttemptId === last.attemptId;
  return true;
}

function candidateScore(task: AgentTask, tab: ManagedTab): number | undefined {
  if (tab.snapshot.status !== 'idle' || !attemptAllowsDispatch(task, tab)) return undefined;
  if (task.project && tab.binding.project.trim() !== task.project) return undefined;
  const roleScore = roleMatchScore(task.targetRole, tab.binding.role);
  if (roleScore === undefined) return undefined;

  let score = roleScore;
  if (tab.snapshot.conversationKey.startsWith('conversation:')) score += 20;
  if (tab.binding.agentSlotId) score += 10;
  return score;
}

interface TaskCandidate {
  tab: ManagedTab;
  score: number;
}

interface TaskCandidates {
  managed: ManagedTask;
  index: number;
  candidates: TaskCandidate[];
}

function candidatesForTask(task: AgentTask, tabs: readonly ManagedTab[]): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];
  for (const tab of tabs) {
    const score = candidateScore(task, tab);
    if (score !== undefined) candidates.push({ tab, score });
  }
  return candidates;
}

function betterCandidate(
  candidate: TaskCandidate,
  current: TaskCandidate | undefined,
  tabFlexibility: ReadonlyMap<number, number>,
): boolean {
  if (!current) return true;
  if (candidate.score !== current.score) return candidate.score > current.score;
  const candidateFlexibility = tabFlexibility.get(candidate.tab.tabId) ?? 0;
  const currentFlexibility = tabFlexibility.get(current.tab.tabId) ?? 0;
  if (candidateFlexibility !== currentFlexibility) return candidateFlexibility < currentFlexibility;
  return candidate.tab.tabId < current.tab.tabId;
}

export function planReadyDispatches(tasks: readonly ManagedTask[], tabs: readonly ManagedTab[]): DispatchDecision[] {
  const ready: TaskCandidates[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const managed = tasks[index]!;
    if (managed.status !== 'ready') continue;
    ready.push({ managed, index, candidates: candidatesForTask(managed.task, tabs) });
  }

  // Minimum-remaining-values first prevents a flexible task from consuming
  // the only compatible tab for a constrained task.
  const tabFlexibility = new Map<number, number>();
  for (const item of ready) {
    for (const candidate of item.candidates) {
      tabFlexibility.set(candidate.tab.tabId, (tabFlexibility.get(candidate.tab.tabId) ?? 0) + 1);
    }
  }

  const claimedTabs = new Set<number>();
  const selectedByIndex = new Map<number, DispatchDecision>();
  const allocationOrder = [...ready].sort((left, right) =>
    left.candidates.length - right.candidates.length ||
    left.managed.task.createdAt - right.managed.task.createdAt ||
    left.managed.task.updatedAt - right.managed.task.updatedAt ||
    left.managed.task.id.localeCompare(right.managed.task.id)
  );

  for (const item of allocationOrder) {
    let selected: TaskCandidate | undefined;
    for (const candidate of item.candidates) {
      if (claimedTabs.has(candidate.tab.tabId)) continue;
      if (betterCandidate(candidate, selected, tabFlexibility)) selected = candidate;
    }

    if (!selected) {
      selectedByIndex.set(item.index, {
        taskId: item.managed.task.id,
        error: `No idle reusable ChatGPT agent is compatible with role ${item.managed.task.targetRole}`,
      });
      continue;
    }
    claimedTabs.add(selected.tab.tabId);
    selectedByIndex.set(item.index, { taskId: item.managed.task.id, tabId: selected.tab.tabId });
  }

  // Allocation is optimized independently of input order, while the result
  // remains stable for callers and preserves deterministic dispatch output.
  const decisions: DispatchDecision[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const decision = selectedByIndex.get(index);
    if (decision) decisions.push(decision);
  }
  return decisions;
}
