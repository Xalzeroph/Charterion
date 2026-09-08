import type { ControlDatabase } from './database';
import type { OrganizationAuthority } from './organizationAuthority';
import type { WorkAuthority } from './workAuthority';

type WorkDocument = Record<string, unknown>;

export interface OrganizationExecutionProjection {
  workItemId: string;
  missionId: string;
  organizationAgentId: string;
  projectId: string;
  runtimeSlotId: string;
  managerTaskId: string;
  task: WorkDocument;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export class OrganizationExecutionBridge {
  constructor(
    private readonly database: ControlDatabase,
    private readonly organization: OrganizationAuthority,
    private readonly work: WorkAuthority,
  ) {}
  materialize(workItemId: string, now = Date.now()): OrganizationExecutionProjection {
    const workItem = this.organization.getWorkItem(required(workItemId, 'Work item id'));
    const mission = this.organization.getMission(workItem.missionId);
    if (!mission.projectId) throw new Error('Executable Organization Work requires a project-bound Mission');
    if (!workItem.ownerAgentId) throw new Error('Executable Organization Work requires one owner Agent');
    if (!['ready','active'].includes(workItem.status)) throw new Error('Organization Work must be ready or active before execution projection');
    if (!['active','blocked'].includes(mission.status)) throw new Error('Organization Mission must be active before execution projection');

    const agent = this.organization.getAgent(workItem.ownerAgentId);
    if (agent.status !== 'active') throw new Error('Executable Organization Work owner must be active');
    const acquisition = this.database.db.prepare(
      "SELECT runtime_slot_id,role FROM organization_runtime_acquisitions WHERE agent_id=? AND project_id=? AND status='acquired' ORDER BY updated_at DESC LIMIT 1",
    ).get(agent.id, mission.projectId) as { runtime_slot_id?: string | null; role?: string } | undefined;
    const runtimeSlotId = required(acquisition?.runtime_slot_id ?? undefined, 'Acquired Organization Agent runtime');
    const workspace = this.organization.activeAgentWorkspace(agent.id);
    if (!workspace || workspace.status !== 'ready') throw new Error('Executable Organization Work owner requires one ready AgentWorkspace');
    const slot = this.database.db.prepare('SELECT project_id,role,desired_state,status FROM agent_slots WHERE id=?').get(runtimeSlotId) as {
      project_id?: string; role?: string; desired_state?: string; status?: string;
    } | undefined;
    if (!slot?.project_id || !slot.role) throw new Error('Organization Agent runtime slot does not exist');
    if (acquisition?.role !== slot.role) throw new Error('Organization Agent runtime role does not match acquired role');
    if (slot.project_id !== mission.projectId) throw new Error('Organization Agent runtime slot belongs to another Project');
    if (agent.runtimeSlotId !== runtimeSlotId) throw new Error('Organization Agent runtime binding does not match acquired runtime');
    if (slot.desired_state !== 'active' || slot.status === 'retired') throw new Error('Organization Agent runtime slot is not active');
    const project = this.database.db.prepare('SELECT name,root_path,status FROM projects WHERE id=?').get(mission.projectId) as {
      name?: string; root_path?: string; status?: string;
    } | undefined;
    if (!project?.name || !project.root_path || project.status !== 'active') throw new Error('Executable Organization Mission requires an active Project');

    const managerTaskId = `org-work-${workItem.id}`;
    const dependencyTaskIds = workItem.dependsOn.map((id) => `org-work-${id}`);
    for (const dependencyTaskId of dependencyTaskIds) {
      if (!this.work.getTask(dependencyTaskId)) throw new Error(`Organization Work dependency ${dependencyTaskId} has not been materialized`);
    }
    const instruction = [
      `Mission: ${mission.title}`,
      mission.objective,
      '',
      `Current work: ${workItem.title}`,
      workItem.objective,
      '',
      `Organization Agent: ${agent.displayName} (${agent.id})`,
      `Mission id: ${mission.id}`,
      `Work item id: ${workItem.id}`,
      `Project root: ${project.root_path}`,
      '',
      'Use only capabilities provisioned by the Workspace Charter and actually visible in this session; capability visibility is authoritative.',
      'Treat the project root, worktree, Git, browser, and external providers as scoped capabilities. Never assume an unavailable tool and never fabricate execution evidence.',
      'Use shared artifacts and evidence by reference. If a required capability is unavailable, record a blocked finding with the missing capability and recovery condition.',
    ].join('\n');
    const task: WorkDocument = {
      id: managerTaskId,
      kind: 'work',
      completionPolicy: workItem.completionPolicy,
      title: workItem.title,
      project: project.name,
      instruction,
      targetRole: slot.role,
      dependsOn: dependencyTaskIds,
      attemptIds: [],
      organizationId: mission.organizationId,
      organizationAgentId: agent.id,
      missionId: mission.id,
      organizationWorkItemId: workItem.id,
      projectId: mission.projectId,
      createdAt: workItem.createdAt,
      updatedAt: now,
    };
    this.work.appendTask(task, now);
    return {
      workItemId: workItem.id,
      missionId: mission.id,
      organizationAgentId: agent.id,
      projectId: mission.projectId,
      runtimeSlotId,
      managerTaskId,
      task: this.work.getTask(managerTaskId)!,
    };
  }
}
