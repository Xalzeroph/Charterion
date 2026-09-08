import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMPT_DISPATCH_POLICY,
  PromptDispatchGovernor,
  normalizePromptDispatchState,
  planPromptDispatch,
  type PromptDispatchGovernorState,
} from '../src/promptDispatchGovernor';

function memoryStore(initial?: unknown) {
  let value = initial;
  let reads = 0;
  let writes = 0;
  return {
    read: async () => { reads += 1; return structuredClone(value); },
    write: async (next: PromptDispatchGovernorState) => { value = structuredClone(next); writes += 1; },
    value: () => structuredClone(value) as PromptDispatchGovernorState | undefined,
    reads: () => reads,
    writes: () => writes,
  };
}

function harness(initial?: unknown) {
  let now = 1_000_000;
  const store = memoryStore(initial);
  const governor = new PromptDispatchGovernor(
    store,
    DEFAULT_PROMPT_DISPATCH_POLICY,
    () => now,
    async (ms) => { now += ms; },
    () => 0,
  );
  return { governor, store, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('PromptDispatchGovernor', () => {
  it('allows and durably reserves the first physical prompt', async () => {
    const h = harness();
    const permit = await h.governor.acquire({ project: 'P', slotId: 'S1', activeGenerations: 0 });
    expect(permit).toMatchObject({ allowed: true, reservedAt: 1_000_000, waitedMs: 0 });
    expect(h.store.value()).toMatchObject({ recentDispatches: [1_000_000], projectLastDispatch: { p: 1_000_000 }, slotLastDispatch: { s1: 1_000_000 } });
  });

  it('serializes concurrent sends and spaces them by the global gap', async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.governor.acquire({ project: 'P1', slotId: 'S1', activeGenerations: 0 }),
      h.governor.acquire({ project: 'P2', slotId: 'S2', activeGenerations: 0 }),
    ]);
    expect(first).toMatchObject({ allowed: true, reservedAt: 1_000_000 });
    expect(second).toMatchObject({ allowed: true, reservedAt: 1_004_000, waitedMs: 4_000 });
    expect(h.store.value()?.recentDispatches).toEqual([1_000_000, 1_004_000]);
  });

  it('keeps short-wait burst contenders moving without holding the serialization lane', async () => {
    const h = harness();
    const permits = await Promise.all([
      h.governor.acquire({ project: 'P1', slotId: 'S1', activeGenerations: 0 }),
      h.governor.acquire({ project: 'P2', slotId: 'S2', activeGenerations: 0 }),
      h.governor.acquire({ project: 'P3', slotId: 'S3', activeGenerations: 0 }),
    ]);
    expect(permits.every((permit) => permit.allowed)).toBe(true);
    const reserved = permits.flatMap((permit) => permit.allowed ? [permit.reservedAt] : []).sort((a, b) => a - b);
    expect(reserved).toEqual([1_000_000, 1_004_000, 1_008_000]);
  });

  it('does not hold the global serialization lane while an acquire is sleeping', async () => {
    let now = 1_000_000;
    const store = memoryStore();
    let releaseSleep!: () => void;
    const sleeping = new Promise<void>((resolve) => { releaseSleep = resolve; });
    let sleepEntered = false;
    const governor = new PromptDispatchGovernor(
      store,
      DEFAULT_PROMPT_DISPATCH_POLICY,
      () => now,
      async (ms) => {
        sleepEntered = true;
        await sleeping;
        now += ms;
      },
      () => 0,
    );

    const first = await governor.acquire({ project: 'P1', slotId: 'S1', activeGenerations: 0 });
    expect(first.allowed).toBe(true);
    const secondPending = governor.acquire({ project: 'P2', slotId: 'S2', activeGenerations: 0 });
    for (let index = 0; index < 5 && !sleepEntered; index += 1) await Promise.resolve();
    expect(sleepEntered).toBe(true);

    const backoffUntil = await governor.noteRateLimit();
    expect(backoffUntil).toBe(now + DEFAULT_PROMPT_DISPATCH_POLICY.baseRateLimitBackoffMs);

    releaseSleep();
    const second = await secondPending;
    expect(second).toMatchObject({ allowed: false, reason: 'rate-limit-backoff' });
  });

  it('hydrates persisted pacing state once and then uses a write-through cache', async () => {
    const h = harness();
    expect((await h.governor.acquire({ project: 'P1', slotId: 'S1', activeGenerations: 0 })).allowed).toBe(true);
    h.advance(DEFAULT_PROMPT_DISPATCH_POLICY.globalMinIntervalMs);
    expect((await h.governor.acquire({ project: 'P2', slotId: 'S2', activeGenerations: 0 })).allowed).toBe(true);
    await h.governor.noteRateLimit();
    expect(h.store.reads()).toBe(1);
    expect(h.store.writes()).toBe(3);
  });

  it('defers instead of blocking when the rolling budget needs a long wait', async () => {
    const now = 1_000_000;
    const recent = Array.from({ length: 8 }, (_, index) => now - 10_000 + index * 500);
    const h = harness({ schemaVersion: 1, recentDispatches: recent, projectLastDispatch: {}, slotLastDispatch: {}, backoffUntil: 0, rateLimitStrikes: 0 });
    const permit = await h.governor.acquire({ activeGenerations: 0 });
    expect(permit).toMatchObject({ allowed: false, reason: 'global-window' });
    expect(permit.allowed ? 0 : permit.retryAfterMs).toBeGreaterThan(DEFAULT_PROMPT_DISPATCH_POLICY.maxInlineWaitMs);
  });

  it('enforces project and AgentSlot pacing independently', () => {
    const state = { schemaVersion: 1, recentDispatches: [], projectLastDispatch: { p: 998_000 }, slotLastDispatch: { s: 999_000 }, backoffUntil: 0, rateLimitStrikes: 0 };
    const plan = planPromptDispatch(state, { project: 'P', slotId: 'S', activeGenerations: 0 }, 1_000_000);
    expect(plan).toEqual({ allowed: false, reason: 'slot-gap', retryAfterMs: 11_000 });
  });

  it('reserves local generation capacity before native status catches up', async () => {
    const h = harness();
    const first = await h.governor.acquire({ reservationKey: 'slot:s1', activeGenerations: 1 });
    expect(first).toMatchObject({ allowed: true, generationReservationId: 'generation-reservation:1' });
    const blocked = await h.governor.acquire({ reservationKey: 'slot:s2', activeGenerations: 1 });
    expect(blocked).toEqual({ allowed: false, reason: 'generation-capacity', retryAfterMs: 5_000 });
    if (!first.allowed || !first.generationReservationId) throw new Error('first reservation missing');
    await h.governor.releaseGenerationReservation(first.generationReservationId);
    h.advance(DEFAULT_PROMPT_DISPATCH_POLICY.globalMinIntervalMs);
    const second = await h.governor.acquire({ reservationKey: 'slot:s2', activeGenerations: 1 });
    expect(second).toMatchObject({ allowed: true, generationReservationId: 'generation-reservation:2' });
  });

  it('releases all reservations for a page key after a direct non-generating observation', async () => {
    const h = harness();
    const first = await h.governor.acquire({ reservationKey: 'tab:7', activeGenerations: 0 });
    expect(first.allowed).toBe(true);
    await h.governor.releaseGenerationReservationsForKey('tab:7');
    h.advance(DEFAULT_PROMPT_DISPATCH_POLICY.globalMinIntervalMs);
    const second = await h.governor.acquire({ reservationKey: 'tab:8', activeGenerations: 0 });
    expect(second).toMatchObject({ allowed: true, generationReservationId: 'generation-reservation:2' });
  });

  it('defers immediately when too many GAM workers are already generating', async () => {
    const h = harness();
    const permit = await h.governor.acquire({ activeGenerations: DEFAULT_PROMPT_DISPATCH_POLICY.maxConcurrentGenerations });
    expect(permit).toEqual({ allowed: false, reason: 'generation-capacity', retryAfterMs: 5_000 });
    expect(h.store.value()).toBeUndefined();
  });

  it('keeps reservations across governor restarts', async () => {
    const h = harness();
    expect((await h.governor.acquire({ project: 'P', slotId: 'S', activeGenerations: 0 })).allowed).toBe(true);
    const restarted = new PromptDispatchGovernor(h.store, DEFAULT_PROMPT_DISPATCH_POLICY, h.now, async (ms) => h.advance(ms), () => 0);
    const next = await restarted.acquire({ project: 'Other', slotId: 'Other', activeGenerations: 0 });
    expect(next).toMatchObject({ allowed: true, reservedAt: 1_004_000, waitedMs: 4_000 });
  });

  it('backs off exponentially after visible ChatGPT rate-limit signals', async () => {
    const h = harness();
    const firstUntil = await h.governor.noteRateLimit();
    expect(firstUntil - h.now()).toBe(DEFAULT_PROMPT_DISPATCH_POLICY.baseRateLimitBackoffMs);
    const blocked = await h.governor.acquire({ activeGenerations: 0 });
    expect(blocked).toMatchObject({ allowed: false, reason: 'rate-limit-backoff' });
    h.advance(60_000);
    const secondUntil = await h.governor.noteRateLimit();
    expect(secondUntil - h.now()).toBe(DEFAULT_PROMPT_DISPATCH_POLICY.baseRateLimitBackoffMs * 2);
  });

  it('does not retain phantom rate-limit backoff when persistence fails', async () => {
    let persisted: PromptDispatchGovernorState | undefined;
    let failNextWrite = true;
    const store = {
      read: async () => structuredClone(persisted),
      write: async (next: PromptDispatchGovernorState) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('storage unavailable');
        }
        persisted = structuredClone(next);
      },
    };
    const governor = new PromptDispatchGovernor(store, DEFAULT_PROMPT_DISPATCH_POLICY, () => 1_000_000, async () => undefined, () => 0);

    await expect(governor.noteRateLimit()).rejects.toThrow('storage unavailable');
    const permit = await governor.acquire({ activeGenerations: 0 });

    expect(permit).toMatchObject({ allowed: true, reservedAt: 1_000_000 });
    expect(persisted).toMatchObject({ backoffUntil: 0, rateLimitStrikes: 0, recentDispatches: [1_000_000] });
  });

  it('resets strike severity after a long quiet period', async () => {
    const h = harness();
    await h.governor.noteRateLimit();
    h.advance(DEFAULT_PROMPT_DISPATCH_POLICY.rateLimitStrikeResetMs + 1);
    const until = await h.governor.noteRateLimit();
    expect(until - h.now()).toBe(DEFAULT_PROMPT_DISPATCH_POLICY.baseRateLimitBackoffMs);
    expect(h.store.value()?.rateLimitStrikes).toBe(1);
  });

  it('sanitizes malformed and expired persisted state', () => {
    const state = normalizePromptDispatchState({
      recentDispatches: ['bad', -1, 999_999], projectLastDispatch: { old: 1, ok: 999_500 },
      slotLastDispatch: null, backoffUntil: 'bad', rateLimitStrikes: -4,
    }, 1_000_000);
    expect(state).toMatchObject({ schemaVersion: 1, recentDispatches: [999_999], projectLastDispatch: { ok: 999_500 }, slotLastDispatch: {}, backoffUntil: 0, rateLimitStrikes: 0 });
  });
});
