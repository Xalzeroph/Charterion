import { describe, expect, it } from 'vitest';
import { RUNTIME_POLICY } from '../src/runtimePolicy';

describe('runtime policy', () => {
  it('keeps concurrency and scheduling values positive and bounded', () => {
    expect(RUNTIME_POLICY.maxParallelBrowserProbes).toBeGreaterThan(0);
    expect(RUNTIME_POLICY.maxParallelBrowserProbes).toBeLessThanOrEqual(32);
    expect(RUNTIME_POLICY.maxParallelTabDispatches).toBeGreaterThan(0);
    expect(RUNTIME_POLICY.maxParallelTabDispatches).toBeLessThanOrEqual(32);
    expect(RUNTIME_POLICY.browserRuntimeReportDebounceMs).toBeGreaterThanOrEqual(0);
    expect(RUNTIME_POLICY.fleetReconcileDebounceMs).toBeGreaterThanOrEqual(0);
    expect(RUNTIME_POLICY.organizationRetryMs).toBeGreaterThan(0);
    expect(RUNTIME_POLICY.automationAlarmPeriodMinutes).toBeGreaterThan(0);
  });

  it('uses distinct stable automation alarm names', () => {
    expect(RUNTIME_POLICY.alarms.fleetReconcile).not.toBe(RUNTIME_POLICY.alarms.organizationDispatch);
    expect(Object.values(RUNTIME_POLICY.alarms).every((name) => name.startsWith('gam:'))).toBe(true);
  });
});
