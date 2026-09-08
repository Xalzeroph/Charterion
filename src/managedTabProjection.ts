import { createAttemptLedgerIndex } from './attemptLedgerIndex';
import type { ChatSnapshot, ManagedTab, RoleBinding, SendAttemptRecord } from './contracts';

export interface ManagedTabObservation {
  tabId: number;
  windowId: number;
  active: boolean;
  snapshot: ChatSnapshot;
}

export function projectManagedTabs(
  observations: readonly ManagedTabObservation[],
  attempts: readonly SendAttemptRecord[],
  resolveBinding: (tabId: number, snapshot: ChatSnapshot) => RoleBinding,
): ManagedTab[] {
  const attemptIndex = createAttemptLedgerIndex(attempts);
  return [...observations]
    .sort((left, right) => left.tabId - right.tabId)
    .map((observation) => {
      const result: ManagedTab = {
        tabId: observation.tabId,
        windowId: observation.windowId,
        active: observation.active,
        snapshot: observation.snapshot,
        binding: resolveBinding(observation.tabId, observation.snapshot),
      };
      const lastAttempt = attemptIndex.latestFor(observation.tabId, observation.snapshot);
      if (lastAttempt) result.lastAttempt = lastAttempt;
      return result;
    });
}
