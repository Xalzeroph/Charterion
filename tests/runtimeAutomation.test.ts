import { describe, expect, it, vi } from 'vitest';
import { ensureAutomationAlarms, isAutomationAlarm } from '../src/runtimeAutomation';
import { RUNTIME_POLICY } from '../src/runtimePolicy';

describe('runtime automation', () => {
  it('creates only missing automation alarms from runtime policy', async () => {
    const get = vi.fn(async (name: string) =>
      name === RUNTIME_POLICY.alarms.fleetReconcile ? { name } : undefined,
    );
    const create = vi.fn(async () => undefined);

    await ensureAutomationAlarms({ get, create });

    expect(get).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      RUNTIME_POLICY.alarms.organizationDispatch,
      { periodInMinutes: RUNTIME_POLICY.automationAlarmPeriodMinutes },
    );
  });

  it('recognizes only policy-owned automation alarm identities', () => {
    expect(isAutomationAlarm(RUNTIME_POLICY.alarms.fleetReconcile)).toBe(true);
    expect(isAutomationAlarm(RUNTIME_POLICY.alarms.organizationDispatch)).toBe(true);
    expect(isAutomationAlarm('other:alarm')).toBe(false);
  });

  it('performs no writes when all automation alarms already exist', async () => {
    const create = vi.fn(async () => undefined);
    await ensureAutomationAlarms({
      get: async (name) => ({ name }),
      create,
    });
    expect(create).not.toHaveBeenCalled();
  });
});
