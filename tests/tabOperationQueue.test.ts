import { describe, expect, it } from 'vitest';
import { TabOperationQueue } from '../src/tabOperationQueue';

describe('TabOperationQueue', () => {
  it('serializes operations for the same tab', async () => {
    const queue = new TabOperationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = queue.run(7, async () => {
      order.push('first:start');
      markFirstStarted();
      await firstGate;
      order.push('first:end');
      return 1;
    });
    const second = queue.run(7, async () => {
      order.push('second:start');
      return 2;
    });

    await firstStarted;
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(queue.pending(7)).toBe(false);
  });

  it('does not let a failed operation poison the next operation on the same tab', async () => {
    const queue = new TabOperationQueue();
    const first = queue.run(7, async () => { throw new Error('boom'); });
    const second = queue.run(7, async () => 2);

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe(2);
    expect(queue.pending(7)).toBe(false);
  });

  it('runs different tab lanes independently', async () => {
    const queue = new TabOperationQueue();
    let releaseSeven!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSeven = resolve; });
    let tabNineCompleted = false;

    const tabSeven = queue.run(7, async () => { await gate; return 7; });
    const tabNine = queue.run(9, async () => { tabNineCompleted = true; return 9; });

    await tabNine;
    expect(tabNineCompleted).toBe(true);
    expect(queue.pending(7)).toBe(true);
    releaseSeven();
    await expect(tabSeven).resolves.toBe(7);
    expect(queue.pending(7)).toBe(false);
  });
});
