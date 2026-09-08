export type OrganizationStatus = 'active' | 'paused' | 'archived';
export type DepartmentStatus = 'active' | 'archived';
export type DomainStatus = 'active' | 'archived';
export type OrganizationAgentStatus = 'active' | 'suspended' | 'retired';
export type MissionStatus = 'proposed' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type WorkItemStatus = 'proposed' | 'ready' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type WorkItemCompletionPolicy = 'structured-result' | 'verified-claim';
export type MissionMemberRole = 'contributor' | 'reviewer' | 'advisor' | 'observer';

export interface OrganizationRecord {
  id: string;
  name: string;
  status: OrganizationStatus;
  purpose: string;
  createdAt: number;
  updatedAt: number;
}

export interface DepartmentRecord {
  id: string;
  organizationId: string;
  name: string;
  purpose: string;
  status: DepartmentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface DomainRecord {
  id: string;
  organizationId: string;
  departmentId: string;
  name: string;
  purpose: string;
  status: DomainStatus;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationAgentRecord {
  id: string;
  organizationId: string;
  displayName: string;
  primaryDepartmentId?: string | undefined;
  runtimeSlotId?: string;
  status: OrganizationAgentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AgentDomainAssignment {
  agentId: string;
  domainId: string;
  responsibility: 'primary' | 'secondary';
  assignedAt: number;
}

export interface MissionRecord {
  id: string;
  organizationId: string;
  projectId?: string | undefined;
  title: string;
  objective: string;
  status: MissionStatus;
  driAgentId?: string | undefined;
  sourceRequestId?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface MissionMemberRecord {
  missionId: string;
  agentId: string;
  role: MissionMemberRole;
  joinedAt: number;
}

export interface WorkItemRecord {
  id: string;
  missionId: string;
  title: string;
  objective: string;
  ownerAgentId?: string | undefined;
  status: WorkItemStatus;
  completionPolicy: WorkItemCompletionPolicy;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
}

export type OrganizationReviewWorkStatus = 'materialized' | 'claimed' | 'decided' | 'completed' | 'blocked';

export interface OrganizationReviewWorkBinding {
  id: string;
  organizationId: string;
  projectId: string;
  missionId: string;
  reviewRequestId: string;
  reviewSlotId: string;
  workItemId: string;
  reviewerAgentId: string;
  runtimeAcquisitionId: string;
  status: OrganizationReviewWorkStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrganizationInput {
  name: string;
  purpose?: string | undefined;
}

export interface CreateDepartmentInput {
  organizationId: string;
  name: string;
  purpose?: string | undefined;
}

export interface CreateDomainInput {
  organizationId: string;
  departmentId: string;
  name: string;
  purpose?: string | undefined;
}

export interface RegisterOrganizationAgentInput {
  organizationId: string;
  displayName: string;
  primaryDepartmentId?: string | undefined;
}

export interface CreateMissionInput {
  organizationId: string;
  projectId?: string | undefined;
  title: string;
  objective: string;
  driAgentId?: string | undefined;
  sourceRequestId?: string | undefined;
}

export interface CreateWorkItemInput {
  missionId: string;
  title: string;
  objective: string;
  ownerAgentId?: string | undefined;
  completionPolicy?: WorkItemCompletionPolicy | undefined;
  dependsOn?: string[] | undefined;
}

export interface OrganizationSnapshot {
  organizations: OrganizationRecord[];
  departments: DepartmentRecord[];
  domains: DomainRecord[];
  agents: OrganizationAgentRecord[];
  agentDomains: AgentDomainAssignment[];
  missions: MissionRecord[];
  missionMembers: MissionMemberRecord[];
  workItems: WorkItemRecord[];
}


export type AgentWorkspaceSecurityMode = 'prompt-guarded' | 'tool-scoped' | 'sandboxed';
export type AgentWorkspaceToolPolicyState = 'unconfigured' | 'configured' | 'unsupported';
export type AgentWorkspaceDangerousActionPolicy = 'approval-required' | 'deny';
export type AgentWorkspaceStatus = 'configuring' | 'ready' | 'suspended' | 'error' | 'retired';

export interface AgentWorkspaceRecord {
  id: string;
  organizationId: string;
  agentId: string;
  generation: number;
  securityMode: AgentWorkspaceSecurityMode;
  rootRef?: string;
  browserProfileId?: string;
  toolProfileRef?: string;
  endpointRefs: string[];
  allowedRefs: string[];
  forbiddenRefs: string[];
  workspaceCharterVersion: string;
  workspaceCharterDigest: string;
  dangerousActionPolicy: AgentWorkspaceDangerousActionPolicy;
  toolPolicyState: AgentWorkspaceToolPolicyState;
  status: AgentWorkspaceStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequestAgentWorkspaceInput {
  agentId: string;
}

export interface ConfigureAgentWorkspaceInput {
  workspaceId: string;
  securityMode?: AgentWorkspaceSecurityMode | undefined;
  rootRef: string;
  browserProfileId: string;
  toolProfileRef: string;
  endpointRefs?: string[] | undefined;
  allowedRefs?: string[] | undefined;
  forbiddenRefs?: string[] | undefined;
  dangerousActionPolicy?: AgentWorkspaceDangerousActionPolicy | undefined;
  toolPolicyState?: AgentWorkspaceToolPolicyState | undefined;
}

export interface ReplaceAgentWorkspaceInput {
  agentId: string;
  reason: string;
}

export interface AgentWorkspaceSnapshot {
  workspaces: AgentWorkspaceRecord[];
}

export interface OrganizationSnapshot {
  agentWorkspaces: AgentWorkspaceRecord[];
}