import { MutationLane } from './mutationLane';
import { RUNTIME_STORAGE_KEYS } from './runtimeStorageKeys';

export type FleetTabMap = Record<string, number>;

export interface FleetTabStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function parseFleetTabMap(value: unknown): FleetTabMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: FleetTabMap = {};
  for (const [slotId, tabId] of Object.entries(value)) {
    if (slotId && Number.isInteger(tabId) && Number(tabId) >= 0) result[slotId] = Number(tabId);
  }
  return result;
}

export class FleetTabRegistry {
  private readonly lane = new MutationLane();

  constructor(
    private readonly storage: FleetTabStorage,
    private readonly key = RUNTIME_STORAGE_KEYS.fleetTabs,
  ) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.lane.run(operation);
  }

  async read(): Promise<FleetTabMap> {
    const stored = await this.storage.get(this.key);
    return parseFleetTabMap(stored[this.key]);
  }

  async write(value: FleetTabMap): Promise<void> {
    const normalized = parseFleetTabMap(value);
    if (Object.keys(normalized).length !== Object.keys(value).length) {
      throw new Error('Fleet tab registry contains an invalid slot or tab id');
    }
    await this.storage.set({ [this.key]: normalized });
  }

  waitForIdle(): Promise<void> {
    return this.lane.waitForIdle();
  }
}
