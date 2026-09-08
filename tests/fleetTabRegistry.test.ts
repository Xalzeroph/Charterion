import { describe, expect, it } from 'vitest';
import { FleetTabRegistry, parseFleetTabMap, type FleetTabStorage } from '../src/fleetTabRegistry';

class MemoryStorage implements FleetTabStorage {
  value: Record<string, unknown> = {};

  async get(_key: string): Promise<Record<string, unknown>> {
    return { ...this.value };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.value, items);
  }
}

describe('fleet tab registry', () => {
  it('sanitizes persisted mappings on read', async () => {
    const storage = new MemoryStorage();
    storage.value['fleetTabs.v1'] = { good: 7, negative: -1, text: '8' };
    const registry = new FleetTabRegistry(storage);

    expect(await registry.read()).toEqual({ good: 7 });
    expect(parseFleetTabMap(null)).toEqual({});
  });

  it('rejects invalid mappings before persistence', async () => {
    const storage = new MemoryStorage();
    const registry = new FleetTabRegistry(storage);

    await expect(registry.write({ good: 1, bad: -1 })).rejects.toThrow('invalid slot or tab id');
    expect(storage.value).toEqual({});
  });

  it('serializes mutations through one registry lane', async () => {
    const storage = new MemoryStorage();
    const registry = new FleetTabRegistry(storage);
    const order: string[] = [];

    const first = registry.run(async () => {
      order.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('first:end');
    });
    const second = registry.run(async () => { order.push('second'); });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
