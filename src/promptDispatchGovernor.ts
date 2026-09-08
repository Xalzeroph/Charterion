export const PROMPT_DISPATCH_GOVERNOR_KEY = 'promptDispatchGovernor.v1';

export type PromptDispatchDeferReason =
  | 'global-gap'
  | 'global-window'
  | 'project-gap'
  | 'slot-gap'
  | 'rate-limit-backoff'
  | 'generation-capacity';

export interface PromptDispatchPolicy {
  globalMinIntervalMs: number;
  globalWindowMs: number;
  maxGlobalInWindow: number;
  projectMinIntervalMs: number;
  slotMinIntervalMs: number;
  maxConcurrentGenerations: number;
  generationRetryMs: number;
  maxInlineWaitMs: number;
  jitterMs: number;
  baseRateLimitBackoffMs: number;
  maxRateLimitBackoffMs: number;
  rateLimitStrikeResetMs: number;
  stateRetentionMs: number;
}

export const DEFAULT_PROMPT_DISPATCH_POLICY: Readonly<PromptDispatchPolicy> = Object.freeze({
  globalMinIntervalMs: 4_000,
  globalWindowMs: 60_000,
  maxGlobalInWindow: 8,
  projectMinIntervalMs: 6_000,
  slotMinIntervalMs: 12_000,
  maxConcurrentGenerations: 2,
  generationRetryMs: 5_000,
  maxInlineWaitMs: 10_000,
  jitterMs: 750,
  baseRateLimitBackoffMs: 5 * 60_000,
  maxRateLimitBackoffMs: 60 * 60_000,
  rateLimitStrikeResetMs: 6 * 60 * 60_000,
  stateRetentionMs: 24 * 60 * 60_000,
});

export interface PromptDispatchGovernorState {
  schemaVersion: 1;
  recentDispatches: number[];
  projectLastDispatch: Record<string, number>;
  slotLastDispatch: Record<string, number>;
  backoffUntil: number;
  rateLimitStrikes: number;
  lastRateLimitAt?: number;
}

export interface PromptDispatchScope {
  project?: string;
  slotId?: string;
  reservationKey?: string;
  activeGenerations: number;
}

export type PromptDispatchPermit =
  | { allowed: true; reservedAt: number; waitedMs: number; generationReservationId?: string }
  | { allowed: false; reason: PromptDispatchDeferReason; retryAfterMs: number };

export interface PromptDispatchGovernorStore {
  read(): Promise<unknown>;
  write(state: PromptDispatchGovernorState): Promise<void>;
}

function emptyState(): PromptDispatchGovernorState {
  return {
    schemaVersion: 1,
    recentDispatches: [],
    projectLastDispatch: {},
    slotLastDispatch: {},
    backoffUntil: 0,
    rateLimitStrikes: 0,
  };
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function normalizeKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeTimestampMap(value: unknown, cutoff: number): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const timestamp = finiteTimestamp(raw);
    if (timestamp !== undefined && timestamp >= cutoff) result[key] = timestamp;
  }
  return result;
}

export function normalizePromptDispatchState(
  value: unknown,
  now: number,
  policy: PromptDispatchPolicy = DEFAULT_PROMPT_DISPATCH_POLICY,
): PromptDispatchGovernorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
  const input = value as Record<string, unknown>;
  const cutoff = Math.max(0, now - policy.stateRetentionMs);
  const recent = Array.isArray(input.recentDispatches)
    ? input.recentDispatches.map(finiteTimestamp).filter((item): item is number => item !== undefined && item >= Math.max(cutoff, now - policy.globalWindowMs)).sort((a, b) => a - b)
    : [];
  const backoffUntil = finiteTimestamp(input.backoffUntil) ?? 0;
  const strikes = typeof input.rateLimitStrikes === 'number' && Number.isInteger(input.rateLimitStrikes) && input.rateLimitStrikes >= 0
    ? input.rateLimitStrikes : 0;
  const lastRateLimitAt = finiteTimestamp(input.lastRateLimitAt);
  const state: PromptDispatchGovernorState = {
    schemaVersion: 1,
    recentDispatches: recent,
    projectLastDispatch: normalizeTimestampMap(input.projectLastDispatch, cutoff),
    slotLastDispatch: normalizeTimestampMap(input.slotLastDispatch, cutoff),
    backoffUntil,
    rateLimitStrikes: strikes,
  };
  if (lastRateLimitAt !== undefined) state.lastRateLimitAt = lastRateLimitAt;
  return state;
}

function constraint(reason: PromptDispatchDeferReason, until: number): { reason: PromptDispatchDeferReason; until: number } {
  return { reason, until };
}

export function planPromptDispatch(
  value: unknown,
  scope: PromptDispatchScope,
  now: number,
  policy: PromptDispatchPolicy = DEFAULT_PROMPT_DISPATCH_POLICY,
): PromptDispatchPermit {
  const state = normalizePromptDispatchState(value, now, policy);
  if (scope.activeGenerations >= policy.maxConcurrentGenerations) {
    return { allowed: false, reason: 'generation-capacity', retryAfterMs: policy.generationRetryMs };
  }
  const waits: Array<{ reason: PromptDispatchDeferReason; until: number }> = [];
  if (state.backoffUntil > now) waits.push(constraint('rate-limit-backoff', state.backoffUntil));
  const lastGlobal = state.recentDispatches.at(-1);
  if (lastGlobal !== undefined) waits.push(constraint('global-gap', lastGlobal + policy.globalMinIntervalMs));
  if (state.recentDispatches.length >= policy.maxGlobalInWindow) {
    const releaseIndex = state.recentDispatches.length - policy.maxGlobalInWindow;
    waits.push(constraint('global-window', state.recentDispatches[releaseIndex]! + policy.globalWindowMs));
  }
  const project = normalizeKey(scope.project);
  const projectLast = project ? state.projectLastDispatch[project] : undefined;
  if (projectLast !== undefined) waits.push(constraint('project-gap', projectLast + policy.projectMinIntervalMs));
  const slotId = normalizeKey(scope.slotId);
  const slotLast = slotId ? state.slotLastDispatch[slotId] : undefined;
  if (slotLast !== undefined) waits.push(constraint('slot-gap', slotLast + policy.slotMinIntervalMs));

  const limiting = waits.reduce<{ reason: PromptDispatchDeferReason; until: number } | undefined>(
    (current, item) => !current || item.until > current.until ? item : current,
    undefined,
  );
  if (!limiting || limiting.until <= now) return { allowed: true, reservedAt: now, waitedMs: 0 };
  return { allowed: false, reason: limiting.reason, retryAfterMs: Math.max(1, limiting.until - now) };
}

function reserveDispatch(
  value: unknown,
  scope: PromptDispatchScope,
  now: number,
  policy: PromptDispatchPolicy,
): PromptDispatchGovernorState {
  const state = normalizePromptDispatchState(value, now, policy);
  state.recentDispatches.push(now);
  const project = normalizeKey(scope.project);
  if (project) state.projectLastDispatch[project] = now;
  const slotId = normalizeKey(scope.slotId);
  if (slotId) state.slotLastDispatch[slotId] = now;
  return state;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PromptDispatchGovernor {
  private tail: Promise<void> = Promise.resolve();
  private readonly generationReservations = new Map<string, string>();
  private reservationSequence = 0;

  constructor(
    private readonly store: PromptDispatchGovernorStore,
    private readonly policy: PromptDispatchPolicy = DEFAULT_PROMPT_DISPATCH_POLICY,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly random: () => number = Math.random,
  ) {}

  async acquire(scope: PromptDispatchScope): Promise<PromptDispatchPermit> {
    const startedAt = this.clock();
    let permit = await this.serialize(() => this.tryAcquireSerialized(scope, startedAt));
    if (
      permit.allowed ||
      permit.reason === 'generation-capacity' ||
      permit.reason === 'rate-limit-backoff' ||
      permit.retryAfterMs > this.policy.maxInlineWaitMs
    ) {
      return permit;
    }

    const jitter = Math.max(0, Math.floor(this.random() * this.policy.jitterMs));
    await this.sleep(permit.retryAfterMs + jitter);
    permit = await this.serialize(() => this.tryAcquireSerialized(scope, startedAt));
    return permit;
  }

  noteRateLimit(): Promise<number> {
    return this.serialize(() => this.noteRateLimitSerialized());
  }

  releaseGenerationReservation(reservationId: string): Promise<void> {
    return this.serialize(async () => {
      this.generationReservations.delete(reservationId);
    });
  }

  releaseGenerationReservationsForKey(reservationKey: string): Promise<void> {
    return this.serialize(async () => {
      for (const [reservationId, key] of this.generationReservations) {
        if (key === reservationKey) this.generationReservations.delete(reservationId);
      }
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async tryAcquireSerialized(scope: PromptDispatchScope, startedAt: number): Promise<PromptDispatchPermit> {
    const now = this.clock();
    const state = normalizePromptDispatchState(await this.store.read(), now, this.policy);
    const plan = planPromptDispatch(
      state,
      { ...scope, activeGenerations: scope.activeGenerations + this.generationReservations.size },
      now,
      this.policy,
    );
    if (!plan.allowed) return plan;

    const reservedAt = this.clock();
    await this.store.write(reserveDispatch(state, scope, reservedAt, this.policy));
    const generationReservationId = scope.reservationKey
      ? `generation-reservation:${++this.reservationSequence}`
      : undefined;
    if (generationReservationId && scope.reservationKey) {
      this.generationReservations.set(generationReservationId, scope.reservationKey);
    }
    return {
      allowed: true,
      reservedAt,
      waitedMs: Math.max(0, reservedAt - startedAt),
      ...(generationReservationId ? { generationReservationId } : {}),
    };
  }

  private async noteRateLimitSerialized(): Promise<number> {
    const now = this.clock();
    const state = normalizePromptDispatchState(await this.store.read(), now, this.policy);
    const withinStrikeWindow = state.lastRateLimitAt !== undefined && now - state.lastRateLimitAt <= this.policy.rateLimitStrikeResetMs;
    const strikes = withinStrikeWindow ? state.rateLimitStrikes + 1 : 1;
    const exponent = Math.min(Math.max(0, strikes - 1), 20);
    const backoffMs = Math.min(this.policy.maxRateLimitBackoffMs, this.policy.baseRateLimitBackoffMs * (2 ** exponent));
    state.rateLimitStrikes = strikes;
    state.lastRateLimitAt = now;
    state.backoffUntil = Math.max(state.backoffUntil, now + backoffMs);
    await this.store.write(state);
    return state.backoffUntil;
  }
}
