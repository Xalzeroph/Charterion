import { RUNTIME_POLICY, type RuntimeAlarmName } from './runtimePolicy';

export interface AutomationAlarmPort {
  get(name: string): Promise<unknown>;
  create(name: string, alarmInfo: { periodInMinutes: number }): Promise<void>;
}

const AUTOMATION_ALARMS = Object.freeze(Object.values(RUNTIME_POLICY.alarms));

export function isAutomationAlarm(name: string): name is RuntimeAlarmName {
  return (AUTOMATION_ALARMS as readonly string[]).includes(name);
}

export async function ensureAutomationAlarms(alarms: AutomationAlarmPort): Promise<void> {
  const existing = await Promise.all(AUTOMATION_ALARMS.map((name) => alarms.get(name)));
  await Promise.all(AUTOMATION_ALARMS.flatMap((name, index) =>
    existing[index]
      ? []
      : [alarms.create(name, { periodInMinutes: RUNTIME_POLICY.automationAlarmPeriodMinutes })],
  ));
}
