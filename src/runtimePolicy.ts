export const RUNTIME_POLICY = Object.freeze({
  controlRequestMessagePrefix: 'control-request:',
  maxParallelBrowserProbes: 6,
  maxParallelTabDispatches: 4,
  browserRuntimeReportDebounceMs: 250,
  fleetReconcileDebounceMs: 150,
  organizationRetryMs: 1000,
  automationAlarmPeriodMinutes: 1,
  alarms: Object.freeze({
    fleetReconcile: 'gam:fleet-reconcile',
    organizationDispatch: 'gam:organization-dispatch',
  }),
} as const);

export type RuntimeAlarmName = typeof RUNTIME_POLICY.alarms[keyof typeof RUNTIME_POLICY.alarms];
