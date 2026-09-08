import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledTrigger } from '../src/scheduledTrigger';

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduled trigger', () => {
  it('replaces an existing debounce timer with the newest schedule', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const trigger = new ScheduledTrigger(action, 'replace');

    trigger.schedule(100);
    trigger.schedule(200);
    vi.advanceTimersByTime(100);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(action).toHaveBeenCalledTimes(1);
    expect(trigger.pending).toBe(false);
  });

  it('keeps the first pending retry instead of extending it', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const trigger = new ScheduledTrigger(action, 'keep');

    trigger.schedule(100);
    trigger.schedule(500);
    vi.advanceTimersByTime(100);
    expect(action).toHaveBeenCalledTimes(1);
    expect(trigger.pending).toBe(false);
  });

  it('cancels pending work and validates delay values', () => {
    vi.useFakeTimers();
    const action = vi.fn();
    const trigger = new ScheduledTrigger(action);

    trigger.schedule(100);
    trigger.cancel();
    vi.advanceTimersByTime(100);
    expect(action).not.toHaveBeenCalled();
    expect(() => trigger.schedule(-1)).toThrow('non-negative');
  });
});
