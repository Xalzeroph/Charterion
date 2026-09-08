export const RUNTIME_STORAGE_KEYS = Object.freeze({
  bindings: 'bindings.v1',
  tabBindings: 'tabBindings.v1',
  sendAttempts: 'sendAttempts.v1',
  tasks: 'tasks.v1',
  messages: 'messages.v1',
  supervisor: 'supervisor.v1',
  fleetTabs: 'fleetTabs.v1',
} as const);

export type RuntimeStorageKey = typeof RUNTIME_STORAGE_KEYS[keyof typeof RUNTIME_STORAGE_KEYS];
