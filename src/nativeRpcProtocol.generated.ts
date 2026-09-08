// GENERATED FILE. Source: shared/native-rpc-protocol.json
// Run: npm run generate:native-rpc-contract

export const NATIVE_CONTROL_HOST = "com.charterion.control" as const;
export const NATIVE_MAX_MESSAGE_BYTES = 1048576 as const;

export const NATIVE_RPC_METHODS = [
  "health",
  "control.snapshot",
  "browser.report",
  "browser.status",
  "agent.browser-report",
  "agent.runtime-report",
  "agent.rollover-request",
  "agent.rollover-begin",
  "agent.rollover-bootstrap",
  "agent.rollover-complete",
  "agent.rollover-fail",
  "agent.rollover-status",
  "browser.operation-plan",
  "browser.operation-dispatch",
  "browser.operation-settle",
  "incident.report",
  "project.list",
  "agent.list",
  "resource.list",
  "lease.list",
  "events.list",
  "org-work.project-execution",
  "work.snapshot",
  "work.replace",
  "work.mutate",
  "work.batch-mutate",
  "fleet.reconcile",
  "workspace.provision",
  "workspace.list",
] as const;

export type NativeRpcMethod = typeof NATIVE_RPC_METHODS[number];

export const NATIVE_RPC_DOMAINS = [
  "agent",
  "browser",
  "control",
  "event",
  "fleet",
  "incident",
  "lease",
  "organization",
  "project",
  "resource",
  "system",
  "work",
  "workspace",
] as const;

export type NativeRpcDomain = typeof NATIVE_RPC_DOMAINS[number];

export const NATIVE_RPC_METHOD_DOMAIN: Readonly<Record<NativeRpcMethod, NativeRpcDomain>> = {
  "health": "system",
  "control.snapshot": "control",
  "browser.report": "browser",
  "browser.status": "browser",
  "agent.browser-report": "agent",
  "agent.runtime-report": "agent",
  "agent.rollover-request": "agent",
  "agent.rollover-begin": "agent",
  "agent.rollover-bootstrap": "agent",
  "agent.rollover-complete": "agent",
  "agent.rollover-fail": "agent",
  "agent.rollover-status": "agent",
  "browser.operation-plan": "browser",
  "browser.operation-dispatch": "browser",
  "browser.operation-settle": "browser",
  "incident.report": "incident",
  "project.list": "project",
  "agent.list": "agent",
  "resource.list": "resource",
  "lease.list": "lease",
  "events.list": "event",
  "org-work.project-execution": "organization",
  "work.snapshot": "work",
  "work.replace": "work",
  "work.mutate": "work",
  "work.batch-mutate": "work",
  "fleet.reconcile": "fleet",
  "workspace.provision": "workspace",
  "workspace.list": "workspace",
};

const nativeRpcMethodSet: ReadonlySet<string> = new Set(NATIVE_RPC_METHODS);

export function assertNativeRpcMethod(method: string): asserts method is NativeRpcMethod {
  if (!nativeRpcMethodSet.has(method)) throw new Error(`Native RPC method ${method} is not declared in shared/native-rpc-protocol.json`);
}
