import { createHash, timingSafeEqual } from 'node:crypto';
import type { ControlPlane } from './controlPlane';
import { OrganizationRpcController } from './organizationRpc';
import { enumParam, numberParam, objectArrayParam, objectParam, record, stringParam } from './rpcParams';
import type {
  AcquireLeaseInput,
  ArtifactKind,
  CapabilityGrant,
  CreateProjectInput,
  IsolationTier,
  IssueCapabilityInput,
  OpenChangeRequestInput,
  SubmitSupervisorReviewInput,
  SupervisorReviewVerdict,
  UpdateChangeRequestInput,
  LeaseMode,
  ProjectStatus,
  RegisterArtifactInput,
  ResourceKind,
  SubmitClaimInput,
  RpcFailure,
  RpcRequest,
  RpcResponse,
  SubmitWorkerRequestInput,
  WorkerRequestType,
  RequestSelfHostingPromotionInput,
  DecideSelfHostingPromotionInput,
  ApplySelfHostingPromotionInput,
} from './contracts';

const ISOLATION_TIERS = ['c0-host', 'c1-container', 'c2-hypervisor', 'c3-ephemeral-vm'] as const;
const PROJECT_STATUSES = ['active', 'draining', 'paused', 'archived'] as const;
const RESOURCE_KINDS = ['workspace','repo','branch','server','gpu','port','service','database','dataset','browser-capacity','remote-lane'] as const;
const LEASE_MODES = ['shared', 'exclusive'] as const;
const ARTIFACT_KINDS = ['file','test-log','report','git-bundle','other'] as const;
const REVIEW_VERDICTS = ['approve','request-changes'] as const;
const BROWSER_AUTH_STATUSES = ['unknown','authenticated','authentication-required'] as const;
const BROWSER_PAGE_HEALTHS = ['unknown','ready','generating','blocked','error','unavailable'] as const;
const AGENT_PAGE_STATUSES = ['idle','generating','blocked','unauthorized','error','unknown','unavailable'] as const;
const BROWSER_OPERATION_OUTCOMES = ['acknowledged','reply-observed','failed','uncertain'] as const;
const INCIDENT_SEVERITIES = ['warning','error','critical'] as const;
const WORKER_REQUEST_TYPES = ['suggestion','blocker','question','resource-request','scope-change','dependency-request','cross-system-request','review-request','risk-alert','worker-request'] as const;

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function failure(id: string, code: string, message: string): RpcFailure {
  return { id, ok: false, error: { code, message } };
}

export class RpcRouter {
  private readonly organizationRpc: OrganizationRpcController;
  constructor(
    private readonly plane: ControlPlane,
    private readonly adminToken: string,
    private readonly browserToken: string,
    private readonly instanceId?: string,
  ) {
    this.organizationRpc = new OrganizationRpcController(plane, {
      requireAdmin: (request) => this.requireAdmin(request),
      requireBrowserOrAdmin: (request) => this.requireBrowserOrAdmin(request),
      requireCapability: (request, scope, input = {}) => this.requireCapability(request, scope, input),
    });
  }

  handle(request: RpcRequest): RpcResponse {
    const id = typeof request?.id === 'string' && request.id ? request.id : 'unknown';
    try {
      if (!request || typeof request !== 'object') return failure(id, 'INVALID_REQUEST', 'Request must be an object');
      if (typeof request.method !== 'string' || !request.method.trim()) return failure(id, 'INVALID_REQUEST', 'method is required');
      if (request.method === 'health') {
        return { id, ok: true, result: { status: 'ok', protocolVersion: 2, instanceId: this.instanceId ?? null } };
      }
      if (this.instanceId && request.instanceId !== this.instanceId) {
        return failure(id, 'INSTANCE_MISMATCH', `RPC instance mismatch: expected ${this.instanceId}`);
      }
      return { id, ok: true, result: this.dispatch(request) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unauthorized = /authentication|Capability token/i.test(message);
      const clientFault = /required|invalid|must be|cannot|does not|not found|conflict|stale|unsupported|already|missing|rejected|evidence|policy|task|attempt|message|lease|workspace|project|request|review|queue|browser|work state|candidate|sha|head|parent|target|subject|authority|claim|commit|ref|grant/i.test(message);
      const code = unauthorized ? 'UNAUTHORIZED' : clientFault ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      return failure(id, code, code === 'INTERNAL_ERROR' ? 'Internal control-plane error' : message);
    }
  }
  private requireAdmin(request: RpcRequest): void {
    const token = request.auth?.adminToken;
    if (!token || !safeEqual(token, this.adminToken)) throw new Error('Admin authentication failed');
  }

  private requireBrowser(request: RpcRequest): void {
    const token = request.auth?.browserToken;
    if (!token || !safeEqual(token, this.browserToken)) throw new Error('Browser authentication failed');
  }

  private requireBrowserOrAdmin(request: RpcRequest): void {
    if (request.auth?.adminToken) this.requireAdmin(request);
    else this.requireBrowser(request);
  }

  private requireFleetAuthority(request: RpcRequest, projectId: string): void {
    if (request.auth?.adminToken) this.requireAdmin(request);
    else this.requireCapability(request, 'agent:fleet', { projectId });
  }

  private requireCapability(request: RpcRequest, scope: string, input: {
    projectId?: string;
    resourceId?: string;
    leaseEpoch?: number;
  } = {}): CapabilityGrant {
    const token = request.auth?.capabilityToken;
    if (!token) throw new Error('Capability token is required');
    const options: { projectId?: string; resourceId?: string; leaseEpoch?: number } = {};
    if (input.projectId !== undefined) options.projectId = input.projectId;
    if (input.resourceId !== undefined) options.resourceId = input.resourceId;
    if (input.leaseEpoch !== undefined) options.leaseEpoch = input.leaseEpoch;
    return this.plane.verifyCapability(token, scope, options);
  }

  private dispatch(request: RpcRequest): unknown {
    const params = request.params ? record(request.params) : {};
    switch (request.method) {
      case 'control.snapshot':
        this.requireBrowserOrAdmin(request);
        const changeRequests = this.plane.changes.listChangeRequests().slice(-200); return { protocolVersion: 2, projects: this.plane.listProjects(), agents: this.plane.listAgentSlots(), resources: this.plane.listResources(), leases: this.plane.listLeases(), claims: this.plane.evidence.listClaims().slice(-200), artifacts: this.plane.evidence.listArtifacts().slice(-200), verifications: this.plane.evidence.listVerifications().slice(-200), changeRequests, reviews: changeRequests.flatMap((item) => this.plane.changes.listReviews(item.id)).slice(-200), mergeQueue: this.plane.changes.listQueue().slice(-200), workerRequests: this.plane.requests.list().slice(-200), promotions: this.plane.promotions.list().slice(-200), browserRuntime: this.plane.listBrowserRuntime(), events: this.plane.listEvents(undefined, 0, 200) };
      case 'browser.report': return this.browserReport(request, params);
      case 'browser.status': this.requireBrowserOrAdmin(request); return this.plane.listBrowserRuntime();
      case 'project.create': return this.projectCreate(request, params);
      case 'project.list': this.requireBrowserOrAdmin(request); return this.plane.listProjects();
      case 'project.status': return this.projectStatus(request, params);
      case 'agent.create':
      case 'agent.spawn': return this.agentCreate(request, params);
      case 'agent.list': return this.agentList(request, params);
      case 'agent.bind': return this.agentBind(request, params);
      case 'agent.suspend': return this.agentSuspend(request, params);
      case 'agent.resume': return this.agentResume(request, params);
      case 'agent.retire': return this.agentRetire(request, params);
      case 'agent.browser-report': return this.agentBrowserReport(request, params);
      case 'agent.rollover-request': return this.agentRolloverRequest(request, params);
      case 'agent.rollover-begin': return this.agentRolloverBegin(request, params);
      case 'agent.rollover-bootstrap': return this.agentRolloverBootstrap(request, params);
      case 'agent.rollover-complete': return this.agentRolloverComplete(request, params);
      case 'agent.rollover-fail': return this.agentRolloverFail(request, params);
      case 'agent.rollover-status': return this.agentRolloverStatus(request, params);
      case 'agent.conversation-list': return this.agentConversationList(request, params);
      case 'agent.checkpoint-list': return this.agentCheckpointList(request, params);
      case 'agent.rollover-list': return this.agentRolloverList(request, params);
      case 'agent.runtime-report': return this.agentRuntimeReport(request, params);
      case 'browser.operation-plan': return this.browserOperationPlan(request, params);
      case 'browser.operation-dispatch': return this.browserOperationDispatch(request, params);
      case 'browser.operation-settle': return this.browserOperationSettle(request, params);
      case 'browser.operation-list': return this.browserOperationList(request, params);
      case 'incident.report': return this.incidentReport(request, params);
      case 'incident.list': return this.incidentList(request, params);
      case 'incident.resolve': return this.incidentResolve(request, params);
      default:
        if (this.organizationRpc.canHandle(request.method)) return this.organizationRpc.handle(request, params);
        return this.dispatchResources(request, params);
    }
  }
  private browserReport(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    const observedAt = numberParam(params, 'observedAt', true);
    return this.plane.reportBrowserRuntime({
      profileId: stringParam(params, 'profileId')!,
      authStatus: enumParam(params, 'authStatus', BROWSER_AUTH_STATUSES)!,
      pageHealth: enumParam(params, 'pageHealth', BROWSER_PAGE_HEALTHS)!,
      openTabs: numberParam(params, 'openTabs')!,
      extensionVersion: stringParam(params, 'extensionVersion')!,
      ...(observedAt !== undefined ? { observedAt } : {}),
    });
  }
  private projectCreate(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    const input: CreateProjectInput = {
      name: stringParam(params, 'name')!,
      rootPath: stringParam(params, 'rootPath')!,
    };
    const isolationTier = enumParam<IsolationTier>(params, 'isolationTier', ISOLATION_TIERS, true);
    const minSlots = numberParam(params, 'minSlots', true);
    const maxSlots = numberParam(params, 'maxSlots', true);
    const weight = numberParam(params, 'weight', true);
    if (isolationTier !== undefined) input.isolationTier = isolationTier;
    if (minSlots !== undefined) input.minSlots = minSlots;
    if (maxSlots !== undefined) input.maxSlots = maxSlots;
    if (weight !== undefined) input.weight = weight;
    return this.plane.createProject(input);
  }

  private projectStatus(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.setProjectStatus(
      stringParam(params, 'projectId')!,
      enumParam<ProjectStatus>(params, 'status', PROJECT_STATUSES)!,
    );
  }

  private agentCreate(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId')!;
    this.requireFleetAuthority(request, projectId);
    return this.plane.createAgentSlot(projectId, stringParam(params, 'role')!);
  }
  private agentList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else { if (!projectId) throw new Error('projectId is required for capability access'); this.requireCapability(request, 'agent:read', { projectId }); }
    return this.plane.listAgentSlots(projectId);
  }

  private agentBind(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.bindAgentConversation(stringParam(params, 'slotId')!, stringParam(params, 'conversationKey')!);
  }

  private agentSuspend(request: RpcRequest, params: Record<string, unknown>): unknown {
    const slot = this.plane.getAgentSlot(stringParam(params, 'slotId')!);
    this.requireFleetAuthority(request, slot.projectId);
    return this.plane.suspendAgentSlot(slot.id);
  }

  private agentResume(request: RpcRequest, params: Record<string, unknown>): unknown {
    const slot = this.plane.getAgentSlot(stringParam(params, 'slotId')!);
    this.requireFleetAuthority(request, slot.projectId);
    return this.plane.resumeAgentSlot(slot.id);
  }

  private agentRetire(request: RpcRequest, params: Record<string, unknown>): unknown {
    const slot = this.plane.getAgentSlot(stringParam(params, 'slotId')!);
    this.requireFleetAuthority(request, slot.projectId);
    return this.plane.retireAgentSlot(slot.id);
  }

  private agentBrowserReport(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    const observedAt = numberParam(params, 'observedAt', true);
    const tabId = numberParam(params, 'tabId', true);
    const conversationKey = stringParam(params, 'conversationKey', true);
    const error = stringParam(params, 'error', true);
    return this.plane.reportAgentBrowser({ slotId: stringParam(params, 'slotId')!, profileId: stringParam(params, 'profileId')!, browserState: enumParam(params, 'browserState', ['absent','opening','open','closing','error'] as const)!, ...(tabId !== undefined ? { tabId } : {}), ...(conversationKey !== undefined ? { conversationKey } : {}), ...(error !== undefined ? { error } : {}), ...(observedAt !== undefined ? { observedAt } : {}) });
  }

  private agentRolloverRequest(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowserOrAdmin(request);
    return this.plane.requestAgentConversationRollover(stringParam(params,'slotId')!, stringParam(params,'reason')!, stringParam(params,'handoffText')!, objectParam(params,'state',true) ?? {});
  }
  private agentRolloverBegin(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.beginAgentConversationRollover(stringParam(params,'slotId')!, stringParam(params,'rolloverId')!); }
  private agentRolloverBootstrap(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.markAgentRolloverBootstrap(stringParam(params,'slotId')!, stringParam(params,'rolloverId')!, stringParam(params,'attemptId')!); }
  private agentRolloverComplete(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.completeAgentConversationRollover(stringParam(params,'slotId')!, stringParam(params,'attemptId')!); }
  private agentRolloverFail(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.failAgentConversationRollover(stringParam(params,'slotId')!, stringParam(params,'error')!); }
  private agentRolloverStatus(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); const slotId=stringParam(params,'slotId')!; const rollover=this.plane.conversations.activeRollover(slotId); return rollover ? { rollover, checkpoint: this.plane.conversations.checkpoint(rollover.checkpointId) } : null; }
  private agentConversationList(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.conversations.listConversations(stringParam(params,'slotId',true)); }
  private agentCheckpointList(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.conversations.listCheckpoints(stringParam(params,'slotId',true)); }
  private agentRolloverList(request: RpcRequest, params: Record<string, unknown>): unknown { this.requireBrowserOrAdmin(request); return this.plane.conversations.listRollovers(stringParam(params,'slotId',true)); }

  private dispatchResources(request: RpcRequest, params: Record<string, unknown>): unknown {
    switch (request.method) {
      case 'resource.declare': return this.resourceDeclare(request, params);
      case 'resource.list': return this.resourceList(request, params);
      case 'lease.acquire': return this.leaseAcquire(request, params);
      case 'lease.list': return this.leaseList(request, params);
      case 'lease.renew': return this.leaseRenew(request, params);
      case 'lease.release': return this.leaseRelease(request, params);
      case 'capability.issue': return this.capabilityIssue(request, params);
      case 'capability.revoke': return this.capabilityRevoke(request, params);
      case 'capability.inspect': return this.capabilityInspect(request, params);
      case 'claim.submit': return this.claimSubmit(request, params);
      case 'claim.list': return this.claimList(request, params);
      case 'artifact.register': return this.artifactRegister(request, params);
      case 'artifact.list': return this.artifactList(request, params);
      case 'claim.verify': return this.claimVerify(request, params);
      case 'verification.list': return this.verificationList(request, params);
      case 'change.open': return this.changeOpen(request, params);
      case 'change.update': return this.changeUpdate(request, params);
      case 'change.list': return this.changeList(request, params);
      case 'review.submit': return this.reviewSubmit(request, params);
      case 'review.list': return this.reviewList(request, params);
      case 'merge.queue': return this.mergeQueue(request, params);
      case 'merge.queue-list': return this.mergeQueueList(request, params);
      case 'merge.prepare': return this.mergePrepare(request, params);
      case 'merge.observe': return this.mergeObserve(request, params);
      case 'promotion.request': return this.promotionRequest(request, params);
      case 'promotion.decide': return this.promotionDecide(request, params);
      case 'promotion.apply': return this.promotionApply(request, params);
      case 'promotion.list': return this.promotionList(request, params);
      case 'request.submit': return this.requestSubmit(request, params);
      case 'request.list': return this.requestList(request, params);
      case 'request.decide': return this.requestDecide(request, params);
      case 'request.resolve': return this.requestResolve(request, params);
      case 'events.list': return this.eventsList(request, params);
      case 'work.snapshot': return this.workSnapshot(request);
      case 'work.replace': return this.workReplace(request, params);
      case 'work.mutate': return this.workMutate(request, params);
      case 'fleet.reconcile': return this.fleetReconcile(request, params);
      case 'workspace.provision': return this.workspaceProvision(request, params);
      case 'workspace.list': return this.workspaceList(request, params);
      case 'workspace.release': return this.workspaceRelease(request, params);
      default: throw new Error(`Unknown RPC method ${request.method}`);
    }
  }
  private fleetReconcile(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    void params;
    return this.plane.reconcileElasticFleet();
  }

  private agentRuntimeReport(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    return this.plane.reportAgentRuntime({
      slotId: stringParam(params, 'slotId')!, profileId: stringParam(params, 'profileId')!, tabId: numberParam(params, 'tabId')!,
      contentEpoch: stringParam(params, 'contentEpoch')!, revision: numberParam(params, 'revision')!,
      pageStatus: enumParam(params, 'pageStatus', AGENT_PAGE_STATUSES)!, semanticSignature: stringParam(params, 'semanticSignature')!,
      observedAt: numberParam(params, 'observedAt')!,
    });
  }

  private browserOperationPlan(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    const projectId = stringParam(params, 'projectId', true); const slotId = stringParam(params, 'slotId', true);
    const conversationKey = stringParam(params, 'conversationKey', true); const tabId = numberParam(params, 'tabId', true);
    const contentEpoch = stringParam(params, 'contentEpoch', true); const plannedAt = numberParam(params, 'plannedAt', true);
    return this.plane.browser.planOperation({
      id: stringParam(params, 'id')!, idempotencyKey: stringParam(params, 'idempotencyKey')!, operation: stringParam(params, 'operation')!,
      preconditionsHash: stringParam(params, 'preconditionsHash')!,
      ...(projectId !== undefined ? { projectId } : {}), ...(slotId !== undefined ? { slotId } : {}),
      ...(conversationKey !== undefined ? { conversationKey } : {}), ...(tabId !== undefined ? { tabId } : {}),
      ...(contentEpoch !== undefined ? { contentEpoch } : {}), ...(plannedAt !== undefined ? { plannedAt } : {}),
    });
  }

  private browserOperationDispatch(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request); return this.plane.browser.dispatchOperation(stringParam(params, 'id')!, numberParam(params, 'dispatchedAt', true) ?? Date.now());
  }

  private browserOperationSettle(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    return this.plane.browser.settleOperation(stringParam(params, 'id')!, enumParam(params, 'outcome', BROWSER_OPERATION_OUTCOMES)!, record(params.evidence ?? {}, 'evidence'), numberParam(params, 'settledAt', true) ?? Date.now());
  }

  private browserOperationList(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowserOrAdmin(request); return this.plane.browser.listOperations(stringParam(params, 'slotId', true));
  }

  private incidentReport(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    return this.plane.browser.reportIncident({ scope: stringParam(params, 'scope')!, severity: enumParam(params, 'severity', INCIDENT_SEVERITIES)!, code: stringParam(params, 'code')!, subject: stringParam(params, 'subject')!, detail: record(params.detail ?? {}, 'detail') });
  }

  private incidentList(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowserOrAdmin(request); return this.plane.browser.listIncidents(params.openOnly === true);
  }

  private incidentResolve(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request); return this.plane.browser.resolveIncident(stringParam(params, 'id')!);
  }

  private workspaceProvision(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowserOrAdmin(request);
    const workspace = this.plane.provisionTaskWorkspace(stringParam(params, 'projectId')!, stringParam(params, 'slotId')!, stringParam(params, 'taskId')!);
    return { ...workspace, controlCliPath: this.plane.workspaces.controlCliPath };
  }

  private workspaceList(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowserOrAdmin(request);
    return this.plane.workspaces.list(stringParam(params, 'projectId', true));
  }

  private workspaceRelease(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.releaseTaskWorkspace(stringParam(params, 'workspaceId')!);
  }

  private resourceDeclare(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    const input: {
      id?: string;
      projectId?: string;
      parentId?: string;
      kind: ResourceKind;
      label: string;
      metadata?: Record<string, unknown>;
    } = {
      kind: enumParam<ResourceKind>(params, 'kind', RESOURCE_KINDS)!,
      label: stringParam(params, 'label')!,
    };
    const id = stringParam(params, 'id', true);
    const projectId = stringParam(params, 'projectId', true);
    const parentId = stringParam(params, 'parentId', true);
    if (id !== undefined) input.id = id;
    if (projectId !== undefined) input.projectId = projectId;
    if (parentId !== undefined) input.parentId = parentId;
    if (params.metadata !== undefined) input.metadata = record(params.metadata, 'metadata');
    return this.plane.declareResource(input);
  }

  private resourceList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else { if (!projectId) throw new Error('projectId is required for capability access'); this.requireCapability(request, 'resource:read', { projectId }); }
    return this.plane.listResources(projectId);
  }
  private leaseAcquire(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    const input: AcquireLeaseInput = {
      resourceId: stringParam(params, 'resourceId')!,
      projectId: stringParam(params, 'projectId')!,
      holderId: stringParam(params, 'holderId')!,
      mode: enumParam<LeaseMode>(params, 'mode', LEASE_MODES)!,
    };
    const taskId = stringParam(params, 'taskId', true);
    const ttlMs = numberParam(params, 'ttlMs', true);
    if (taskId !== undefined) input.taskId = taskId;
    if (ttlMs !== undefined) input.ttlMs = ttlMs;
    return this.plane.acquireLease(input);
  }

  private leaseList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const resourceId = stringParam(params, 'resourceId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else { if (!resourceId) throw new Error('resourceId is required for capability access'); this.requireCapability(request, 'lease:read', { resourceId }); }
    return this.plane.listLeases(resourceId);
  }

  private leaseRenew(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.renewLease(stringParam(params, 'leaseId')!, numberParam(params, 'epoch')!, numberParam(params, 'ttlMs')!);
  }

  private leaseRelease(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.releaseLease(stringParam(params, 'leaseId')!, numberParam(params, 'epoch')!);
  }
  private capabilityIssue(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    const scopes = params.scopes;
    const resourceIds = params.resourceIds;
    if (!Array.isArray(scopes) || !scopes.every((value) => typeof value === 'string')) throw new Error('scopes must be a string array');
    if (resourceIds !== undefined && (!Array.isArray(resourceIds) || !resourceIds.every((value) => typeof value === 'string'))) {
      throw new Error('resourceIds must be a string array');
    }
    const input: IssueCapabilityInput = {
      subject: stringParam(params, 'subject')!,
      projectId: stringParam(params, 'projectId')!,
      scopes: scopes as string[],
      ttlMs: numberParam(params, 'ttlMs')!,
    };
    const agentSlotId = stringParam(params, 'agentSlotId', true);
    const taskId = stringParam(params, 'taskId', true);
    const leaseEpoch = numberParam(params, 'leaseEpoch', true);
    if (agentSlotId !== undefined) input.agentSlotId = agentSlotId;
    if (taskId !== undefined) input.taskId = taskId;
    if (leaseEpoch !== undefined) input.leaseEpoch = leaseEpoch;
    if (resourceIds !== undefined) input.resourceIds = resourceIds as string[];
    return this.plane.issueCapability(input);
  }

  private claimSubmit(request: RpcRequest, params: Record<string, unknown>): unknown {
    const input: SubmitClaimInput = {
      projectId: stringParam(params, 'projectId')!,
      taskId: stringParam(params, 'taskId')!,
      subject: stringParam(params, 'subject')!,
      resourceId: stringParam(params, 'resourceId')!,
      leaseEpoch: numberParam(params, 'leaseEpoch')!,
      summary: stringParam(params, 'summary')!,
    };
    const attemptId = stringParam(params, 'attemptId', true);
    const commitSha = stringParam(params, 'commitSha', true);
    if (attemptId !== undefined) input.attemptId = attemptId;
    if (commitSha !== undefined) input.commitSha = commitSha;
    const grant = this.requireCapability(request, 'claim:submit', {
      projectId: input.projectId, resourceId: input.resourceId, leaseEpoch: input.leaseEpoch,
    });
    if (grant.subject !== input.subject) throw new Error('Capability subject does not match claim subject');
    if (!grant.taskId || grant.taskId !== input.taskId) throw new Error('Capability task does not match claim task');
    return this.plane.evidence.submitClaim(input);
  }

  private claimList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else { if (!projectId) throw new Error('projectId is required for capability access'); this.requireCapability(request, 'claim:read', { projectId }); }
    return this.plane.evidence.listClaims(projectId);
  }
  private artifactRegister(request: RpcRequest, params: Record<string, unknown>): unknown {
    const claim = this.plane.evidence.getClaim(stringParam(params, 'claimId')!);
    const grant = this.requireCapability(request, 'artifact:register', {
      projectId: claim.projectId, resourceId: claim.resourceId, leaseEpoch: claim.leaseEpoch,
    });
    if (grant.subject !== claim.subject) throw new Error('Capability subject does not own the claim');
    if (!grant.taskId || grant.taskId !== claim.taskId) throw new Error('Capability task does not match claim task');
    const input: RegisterArtifactInput = {
      claimId: claim.id,
      subject: claim.subject,
      path: stringParam(params, 'path')!,
      kind: enumParam<ArtifactKind>(params, 'kind', ARTIFACT_KINDS)!,
    };
    if (params.metadata !== undefined) input.metadata = record(params.metadata, 'metadata');
    return this.plane.evidence.registerArtifact(input);
  }

  private artifactList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const claimId = stringParam(params, 'claimId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else {
      if (!claimId) throw new Error('claimId is required for capability access');
      const claim = this.plane.evidence.getClaim(claimId);
      this.requireCapability(request, 'claim:read', { projectId: claim.projectId });
    }
    return this.plane.evidence.listArtifacts(claimId);
  }
  private claimVerify(request: RpcRequest, params: Record<string, unknown>): unknown {
    const claimId = stringParam(params, 'claimId')!;
    const claim = this.plane.evidence.getClaim(claimId);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else {
      const grant = this.requireCapability(request, 'claim:verify', { projectId: claim.projectId, resourceId: claim.resourceId, leaseEpoch: claim.leaseEpoch });
      if (grant.taskId !== claim.taskId || grant.subject !== claim.subject) throw new Error('Capability does not own this claim task');
    }
    return this.plane.verifyClaimAndCompleteTask(claimId);
  }

  private verificationList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const claimId = stringParam(params, 'claimId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else {
      if (!claimId) throw new Error('claimId is required for capability access');
      const claim = this.plane.evidence.getClaim(claimId);
      this.requireCapability(request, 'claim:read', { projectId: claim.projectId });
    }
    return this.plane.evidence.listVerifications(claimId);
  }

  private changeOpen(request: RpcRequest, params: Record<string, unknown>): unknown {
    const input: OpenChangeRequestInput = {
      projectId: stringParam(params, 'projectId')!, taskId: stringParam(params, 'taskId')!,
      subject: stringParam(params, 'subject')!, branch: stringParam(params, 'branch')!, targetBranch: stringParam(params, 'targetBranch')!,
      baseSha: stringParam(params, 'baseSha')!, headSha: stringParam(params, 'headSha')!, claimId: stringParam(params, 'claimId')!,
    };
    const claim = this.plane.evidence.getClaim(input.claimId);
    const grant = this.requireCapability(request, 'change:open', {
      projectId: input.projectId, resourceId: claim.resourceId, leaseEpoch: claim.leaseEpoch,
    });
    if (grant.subject !== input.subject || grant.taskId !== input.taskId) throw new Error('Capability does not own this Change Request task');
    return this.plane.changes.open(input);
  }

  private changeUpdate(request: RpcRequest, params: Record<string, unknown>): unknown {
    const current = this.plane.changes.getChangeRequest(stringParam(params, 'changeRequestId')!);
    const input: UpdateChangeRequestInput = {
      changeRequestId: current.id, subject: stringParam(params, 'subject')!,
      headSha: stringParam(params, 'headSha')!, claimId: stringParam(params, 'claimId')!,
    };
    const claim = this.plane.evidence.getClaim(input.claimId);
    const grant = this.requireCapability(request, 'change:update', {
      projectId: current.projectId, resourceId: claim.resourceId, leaseEpoch: claim.leaseEpoch,
    });
    if (grant.subject !== input.subject || grant.taskId !== current.taskId) throw new Error('Capability does not own this Change Request task');
    return this.plane.changes.update(input);
  }

  private changeList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else {
      if (!projectId) throw new Error('projectId is required for capability access');
      this.requireCapability(request, 'change:read', { projectId });
    }
    return this.plane.changes.listChangeRequests(projectId);
  }

  private reviewSubmit(request: RpcRequest, params: Record<string, unknown>): unknown {
    const current = this.plane.changes.getChangeRequest(stringParam(params, 'changeRequestId')!);
    const input: SubmitSupervisorReviewInput = {
      changeRequestId: current.id, reviewerSubject: stringParam(params, 'reviewerSubject')!,
      headSha: stringParam(params, 'headSha')!, verdict: enumParam<SupervisorReviewVerdict>(params, 'verdict', REVIEW_VERDICTS)!,
      body: stringParam(params, 'body')!,
    };
    const grant = this.requireCapability(request, 'change:review', { projectId: current.projectId });
    if (grant.subject !== input.reviewerSubject) throw new Error('Capability subject does not match reviewer');
    return this.plane.changes.review(input);
  }

  private reviewList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const changeRequestId = stringParam(params, 'changeRequestId')!;
    const current = this.plane.changes.getChangeRequest(changeRequestId);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else this.requireCapability(request, 'change:read', { projectId: current.projectId });
    return this.plane.changes.listReviews(changeRequestId);
  }

  private mergeQueue(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.changes.queue(stringParam(params, 'changeRequestId')!);
  }

  private mergePrepare(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.changes.prepareMergeCandidate(stringParam(params, 'queueEntryId')!);
  }

  private mergeObserve(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.changes.observeIntegration(stringParam(params, 'queueEntryId')!);
  }
  private mergeQueueList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else {
      if (!projectId) throw new Error('projectId is required for capability access');
      this.requireCapability(request, 'change:read', { projectId });
    }
    return this.plane.changes.listQueue(projectId);
  }

  private capabilityRevoke(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireAdmin(request);
    return this.plane.revokeCapability(stringParam(params, 'capabilityId')!);
  }
  private capabilityInspect(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    const resourceId = stringParam(params, 'resourceId', true);
    const leaseEpoch = numberParam(params, 'leaseEpoch', true);
    const token = request.auth?.capabilityToken;
    if (!token) throw new Error('Capability token is required');
    const options: { projectId?: string; resourceId?: string; leaseEpoch?: number } = {};
    if (projectId !== undefined) options.projectId = projectId;
    if (resourceId !== undefined) options.resourceId = resourceId;
    if (leaseEpoch !== undefined) options.leaseEpoch = leaseEpoch;
    return this.plane.verifyCapability(token, 'status:read', options);
  }

  private promotionRequest(request: RpcRequest, params: Record<string, unknown>): unknown {
    const input: RequestSelfHostingPromotionInput = {
      projectId: stringParam(params, 'projectId')!, idempotencyKey: stringParam(params, 'idempotencyKey')!,
      claimId: stringParam(params, 'claimId')!, candidateSha: stringParam(params, 'candidateSha')!,
      targetRef: stringParam(params, 'targetRef')!, expectedParentSha: stringParam(params, 'expectedParentSha')!,
      requestedBy: stringParam(params, 'requestedBy')!,
    };
    const grant = this.requireCapability(request, 'promotion:request', { projectId: input.projectId });
    if (grant.subject !== input.requestedBy) throw new Error('Capability subject does not match promotion requester');
    return this.plane.promotions.request(input);
  }

  private promotionDecide(request: RpcRequest, params: Record<string, unknown>): unknown {
    const promotionId = stringParam(params, 'promotionId')!;
    const current = this.plane.promotions.get(promotionId);
    const authoritySubject = stringParam(params, 'authoritySubject')!;
    const grant = this.requireCapability(request, 'promotion:decide', { projectId: current.projectId });
    if (grant.subject !== authoritySubject) throw new Error('Capability subject does not match promotion authority');
    if (grant.taskId !== undefined) throw new Error('Task-bound capability cannot decide Parent/Candidate promotion');
    const input: DecideSelfHostingPromotionInput = {
      promotionId, authoritySubject,
      decision: enumParam(params, 'decision', ['approve', 'reject'] as const)!,
      reason: stringParam(params, 'reason')!,
    };
    return this.plane.promotions.decide(input);
  }

  private promotionApply(request: RpcRequest, params: Record<string, unknown>): unknown {
    const promotionId = stringParam(params, 'promotionId')!;
    const current = this.plane.promotions.get(promotionId);
    const authoritySubject = stringParam(params, 'authoritySubject')!;
    const grant = this.requireCapability(request, 'promotion:apply', { projectId: current.projectId });
    if (grant.subject !== authoritySubject) throw new Error('Capability subject does not match promotion authority');
    if (grant.taskId !== undefined) throw new Error('Task-bound capability cannot apply Parent/Candidate promotion');
    const input: ApplySelfHostingPromotionInput = { promotionId, authoritySubject };
    return this.plane.promotions.apply(input);
  }

  private promotionList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId')!;
    if (request.auth?.adminToken) this.requireAdmin(request);
    else this.requireCapability(request, 'promotion:read', { projectId });
    return this.plane.promotions.list(projectId);
  }
  private requestSubmit(request: RpcRequest, params: Record<string, unknown>): unknown {
    const input: SubmitWorkerRequestInput = { projectId: stringParam(params, 'projectId')!, fromSubject: stringParam(params, 'fromSubject')!, type: enumParam<WorkerRequestType>(params, 'type', WORKER_REQUEST_TYPES)!, title: stringParam(params, 'title')!, body: stringParam(params, 'body')! };
    const taskId = stringParam(params, 'taskId', true); const suggestedAction = stringParam(params, 'suggestedAction', true);
    if (taskId !== undefined) input.taskId = taskId; if (suggestedAction !== undefined) input.suggestedAction = suggestedAction;
    const grant = this.requireCapability(request, 'request:submit', { projectId: input.projectId });
    if (grant.subject !== input.fromSubject) throw new Error('Capability subject does not match request subject');
    if (grant.taskId && grant.taskId !== input.taskId) throw new Error('Capability task does not match worker request task');
    return this.plane.requests.submit(input);
  }

  private requestList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true); const status = stringParam(params, 'status', true) as 'open'|'accepted'|'rejected'|'resolved'|undefined;
    if (status && !['open','accepted','rejected','resolved'].includes(status)) throw new Error('status is invalid');
    if (request.auth?.adminToken) this.requireAdmin(request); else if (request.auth?.browserToken) this.requireBrowser(request); else { if (!projectId) throw new Error('projectId is required for capability access'); this.requireCapability(request, 'request:read', { projectId }); }
    return this.plane.requests.list(projectId, status);
  }

  private requestDecide(request: RpcRequest, params: Record<string, unknown>): unknown {
    const current = this.plane.requests.get(stringParam(params, 'requestId')!); const supervisorSubject = stringParam(params, 'supervisorSubject')!;
    if (request.auth?.adminToken) this.requireAdmin(request); else { const grant = this.requireCapability(request, 'request:review', { projectId: current.projectId }); if (grant.subject !== supervisorSubject) throw new Error('Capability subject does not match Supervisor'); }
    const decision = enumParam(params, 'decision', ['accept','reject'] as const)!;
    return this.plane.requests.decide({ requestId: current.id, supervisorSubject, decision, note: stringParam(params, 'note', true) ?? '' });
  }

  private requestResolve(request: RpcRequest, params: Record<string, unknown>): unknown {
    const current = this.plane.requests.get(stringParam(params, 'requestId')!); const supervisorSubject = stringParam(params, 'supervisorSubject')!;
    if (request.auth?.adminToken) this.requireAdmin(request); else { const grant = this.requireCapability(request, 'request:review', { projectId: current.projectId }); if (grant.subject !== supervisorSubject) throw new Error('Capability subject does not match Supervisor'); }
    return this.plane.requests.resolve(current.id, supervisorSubject, stringParam(params, 'note', true) ?? '');
  }

  private workSnapshot(request: RpcRequest): unknown {
    this.requireBrowserOrAdmin(request);
    return this.plane.work.snapshot();
  }

  private workReplace(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    return this.plane.work.replace({
      expectedRevision: numberParam(params, 'expectedRevision')!,
      transportGeneration: stringParam(params, 'transportGeneration')!, transportSequence: numberParam(params, 'transportSequence')!, transportMessageId: stringParam(params, 'transportMessageId')!,
      tasks: objectArrayParam(params, 'tasks'),
      attempts: objectArrayParam(params, 'attempts'),
      messages: objectArrayParam(params, 'messages'),
    });
  }

  private workMutate(request: RpcRequest, params: Record<string, unknown>): unknown {
    this.requireBrowser(request);
    const kind = enumParam(params, 'kind', ['task', 'attempt', 'message'] as const)!;
    const document = objectParam(params, 'document')!;
    return this.plane.work.upsert({
      kind,
      expectedRevision: numberParam(params, 'expectedRevision')!,
      transportGeneration: stringParam(params, 'transportGeneration')!,
      transportSequence: numberParam(params, 'transportSequence')!,
      transportMessageId: stringParam(params, 'transportMessageId')!,
      document,
    });
  }

  private eventsList(request: RpcRequest, params: Record<string, unknown>): unknown {
    const projectId = stringParam(params, 'projectId', true);
    if (request.auth?.adminToken) this.requireAdmin(request);
    else if (request.auth?.browserToken) this.requireBrowser(request);
    else { if (!projectId) throw new Error('projectId is required for capability access'); this.requireCapability(request, 'event:read', { projectId }); }
    return this.plane.listEvents(
      projectId,
      numberParam(params, 'afterSeq', true) ?? 0,
      numberParam(params, 'limit', true) ?? 200,
    );
  }
}
