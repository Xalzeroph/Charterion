import type { ControlPlane } from './controlPlane';
import type { ProjectCell } from './contracts';
import type {
  AgentWorkspaceRecord,
  MissionRecord,
  OrganizationAgentRecord,
  OrganizationRecord,
  WorkItemRecord,
  WorkItemCompletionPolicy,
} from './organizationContracts';
import type { OrganizationRuntimeAcquisitionRecord } from './organizationRuntimeAcquisitionAuthority';
import type { OrganizationExecutionProjection } from './organizationExecutionBridge';
import type { WorkRequestRecord, WorkPriority, WorkRequesterKind } from './workIngressContracts';

export interface AutonomousIntakeInput {
  objective: string;
  organizationId?: string | undefined;
  projectId?: string | undefined;
  projectName?: string | undefined;
  rootPath?: string | undefined;
  requesterKind?: WorkRequesterKind | undefined;
  requesterIdentity?: string | undefined;
  contextRefs?: string[] | undefined;
  constraints?: string[] | undefined;
  desiredOutputs?: string[] | undefined;
  priority?: WorkPriority | undefined;
  completionPolicy?: WorkItemCompletionPolicy | undefined;
  missionTitle?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface AutonomousIntakeResult {
  request: WorkRequestRecord;
  organization: OrganizationRecord;
  project: ProjectCell;
  mission: MissionRecord;
  workItem: WorkItemRecord;
  dri: OrganizationAgentRecord;
  workspace: AgentWorkspaceRecord;
  runtime: OrganizationRuntimeAcquisitionRecord;
  projection: OrganizationExecutionProjection;
}function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizedRoot(value: string): string {
  return required(value, 'Project root path').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'autonomous-mission';
}

function activeProject(plane: ControlPlane, input: AutonomousIntakeInput): ProjectCell {
  if (input.projectId) {
    const project = plane.listProjects().find((item) => item.id === input.projectId);
    if (!project) throw new Error(`Project ${input.projectId} does not exist`);
    if (project.status === 'archived') throw new Error('Cannot intake work into an archived project');
    return project;
  }
  const projects = plane.listProjects().filter((item) => item.status !== 'archived');
  const root = input.rootPath?.trim();
  const name = input.projectName?.trim();
  const matches = projects.filter((item) =>
    (root && normalizedRoot(item.rootPath) === normalizedRoot(root)) ||
    (name && item.name.toLowerCase() === name.toLowerCase()),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error('Project selector matches multiple active projects');
  if (root || name) {
    return plane.createProject({
      name: name || safeSlug(input.objective),
      rootPath: required(root, 'Project root path'),
      minSlots: 0,
      maxSlots: 8,
      weight: 1,
    });
  }
  if (projects.length === 1) return projects[0]!;
  throw new Error('Autonomous intake needs a projectId, projectName/rootPath, or one unambiguous active project');
}function activeOrganization(plane: ControlPlane, input: AutonomousIntakeInput): OrganizationRecord {
  if (input.organizationId) return plane.organization.getOrganization(input.organizationId);
  const organizations = plane.organization.listOrganizations().filter((item) => item.status === 'active');
  const preferred = organizations.find((item) => item.name === 'Charterion Engineering Organization');
  if (preferred) return preferred;
  if (organizations.length === 1) return organizations[0]!;
  if (organizations.length > 1) throw new Error('Autonomous intake needs an organizationId when multiple organizations are active');
  return plane.organization.createOrganization({
    name: 'Charterion Engineering Organization',
    purpose: 'Autonomous engineering organization runtime',
  });
}

function ensureMissionLead(plane: ControlPlane, organization: OrganizationRecord, project: ProjectCell, now: number): OrganizationAgentRecord {
  const active = plane.organization.listAgents(organization.id).filter((item) => item.status === 'active' && !item.runtimeSlotId);
  if (active.length > 0) return active.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]!;
  const departments = plane.organization.listDepartments(organization.id);
  const department = departments[0] ?? plane.organization.createDepartment({
    organizationId: organization.id,
    name: 'Architecture & Systems',
    purpose: 'Mission ownership, architecture coherence, and autonomous decomposition',
  }, now);
  const agent = plane.organization.registerAgent({
    organizationId: organization.id,
    displayName: 'Autonomous Mission Lead',
    primaryDepartmentId: department.id,
  }, now);
  void project;
  return agent;
}function configureWorkspace(plane: ControlPlane, agent: OrganizationAgentRecord, project: ProjectCell, now: number): AgentWorkspaceRecord {
  let workspace = plane.organization.activeAgentWorkspace(agent.id);
  if (!workspace) workspace = plane.organization.requestAgentWorkspace({ agentId: agent.id }, now);
  if (workspace.status === 'ready') return workspace;
  if (workspace.status !== 'configuring' && workspace.status !== 'error') throw new Error('Agent workspace is not configurable');
  return plane.organization.configureAgentWorkspace({
    workspaceId: workspace.id,
    rootRef: project.rootPath,
    browserProfileId: `charterion-agent-${agent.id}`,
    toolProfileRef: 'default',
    allowedRefs: [project.rootPath],
    forbiddenRefs: [],
    securityMode: 'prompt-guarded',
    dangerousActionPolicy: 'approval-required',
    toolPolicyState: 'unconfigured',
  }, now);
}

export class AutonomousIntakeAuthority {
  constructor(private readonly plane: ControlPlane) {}

  submit(input: AutonomousIntakeInput, now = Date.now()): AutonomousIntakeResult {
    const objective = required(input.objective, 'Work objective');
    const organization = activeOrganization(this.plane, input);
    if (organization.status !== 'active') throw new Error('Autonomous intake requires an active organization');
    const project = activeProject(this.plane, input);
    const request = this.plane.ingress.submit({
      organizationId: organization.id,
      projectId: project.id,
      requesterKind: input.requesterKind ?? 'human',
      requesterIdentity: input.requesterIdentity ?? 'human:intake',
      objective,
      contextRefs: input.contextRefs,
      constraints: input.constraints,
      desiredOutputs: input.desiredOutputs,
      priority: input.priority,
      idempotencyKey: input.idempotencyKey,
    }, now);
    if (request.status === 'rejected' || request.status === 'cancelled') {
      throw new Error(`Cannot continue an ${request.status} work request`);
    }
    const existingMission = request.status === 'accepted' ? this.plane.ingress.missionFor(request.id) : undefined;
    const dri = existingMission?.driAgentId
      ? this.plane.organization.getAgent(existingMission.driAgentId)
      : ensureMissionLead(this.plane, organization, project, now);
    const workspace = configureWorkspace(this.plane, dri, project, now);
    const accepted = request.status === 'accepted'
      ? request
      : this.plane.ingress.accept({
          requestId: request.id,
          acceptedBy: 'system:autonomous-intake',
          missionTitle: input.missionTitle,
          driAgentId: dri.id,
          completionPolicy: input.completionPolicy,
        }, now);
    const mission = this.plane.ingress.missionFor(accepted.id);
    if (!mission?.projectId) throw new Error('Autonomous intake produced no project-bound Mission');
    const workItem = this.plane.ingress.workFor(accepted.id)[0];
    if (!workItem) throw new Error('Autonomous intake produced no Work item');
    const runtime = this.plane.organizationRuntime.requestAndAcquire({
      organizationId: organization.id,
      agentId: dri.id,
      projectId: project.id,
      role: 'Mission Lead',
      idempotencyKey: `intake-runtime:${dri.id}:${project.id}`,
    }, now);
    const managerTaskId = `org-work-${workItem.id}`;
    const projection = this.plane.work.getTask(managerTaskId)
      ? {
          workItemId: workItem.id, missionId: mission.id, organizationAgentId: dri.id,
          projectId: project.id, runtimeSlotId: runtime.runtimeSlotId!,
          managerTaskId, task: this.plane.work.getTask(managerTaskId)!,
        }
      : this.plane.organizationExecution.materialize(workItem.id, now);
    return { request: accepted, organization, project, mission, workItem, dri, workspace, runtime, projection };
  }
}