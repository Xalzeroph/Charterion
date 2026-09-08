import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';
import type { TaskWorkspace } from '../src/contracts';

const cleanups: Array<() => void> = [];
const gitPath = process.env.GAM_GIT_PATH || 'git';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(gitPath, args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'git failed');
  return result.stdout.trim();
}

function workspace(repo: string, baseSha: string): TaskWorkspace {
  return {
    id: 'task-workspace-real',
    projectId: 'project-real',
    taskId: 'org-work-real',
    slotId: 'worker-slot',
    repoPath: repo,
    path: repo,
    branch: 'feature',
    baseSha,
    resourceId: 'resource-real',
    leaseId: 'lease-real',
    leaseEpoch: 1,
    capabilityId: 'capability-real',
    capabilityTokenPath: join(repo, 'capability.token'),
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe('OrganizationWorkflowCoordinator real Git closure', () => {
  it('materializes durable reviewer work and promotes the exact candidate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'charterion-org-e2e-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    const init = spawnSync(gitPath, ['init', '-b', 'main', repo], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (init.status !== 0) throw new Error(init.stderr);
    git(repo, 'config', 'user.name', 'Charterion E2E');
    git(repo, 'config', 'user.email', 'charterion-e2e@example.invalid');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'switch', '-c', 'feature');
    writeFileSync(join(repo, 'result.txt'), 'real candidate\n');
    git(repo, 'add', 'result.txt'); git(repo, 'commit', '-m', 'candidate');
    const headSha = git(repo, 'rev-parse', 'HEAD');

    const database = new ControlDatabase(join(dir, 'global.db'));
    const plane = new ControlPlane(database, gitPath);
    cleanups.push(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });

    const project = plane.createProject({ name: 'Real Organization Project', rootPath: repo, minSlots: 0, maxSlots: 4 });
    const resource = plane.declareResource({ projectId: project.id, kind: 'workspace', label: 'worker' });
    const organization = plane.organization.createOrganization({ name: 'Real Charterion Org' });
    plane.organization.createDepartment({ organizationId: organization.id, name: 'Engineering' });
    const dri = plane.organization.registerAgent({ organizationId: organization.id, displayName: 'DRI' });
    const mission = plane.organization.createMission({
      organizationId: organization.id, projectId: project.id, title: 'Ship real result',
      objective: 'Produce and integrate the candidate', driAgentId: dri.id,
    });
    plane.organization.setMissionStatus(mission.id, 'active');
    const work = plane.organization.createWorkItem({
      missionId: mission.id, title: 'Implement result', objective: 'Change the real repository',
      ownerAgentId: dri.id,
    });
    plane.organization.setWorkStatus(work.id, 'ready');
    const taskId = 'org-work-' + work.id;
    const lease = plane.acquireLease({
      resourceId: resource.id, projectId: project.id, holderId: 'worker', taskId,
      mode: 'exclusive', ttlMs: 60_000,
    });
    const claim = plane.evidence.submitClaim({
      projectId: project.id, taskId, subject: 'worker',
      resourceId: resource.id, leaseEpoch: lease.epoch, summary: 'real candidate', commitSha: headSha,
    });
    const verification = plane.evidence.verifyClaim(claim.id);
    const checkedClaim = plane.evidence.getClaim(claim.id);
    const result = plane.organizationWorkflow.reconcileVerifiedWork(
      checkedClaim, verification, workspace(repo, baseSha), 100,
    );
    expect(result.status).toBe('review-ready');
    expect(result.reviewRequest).toBeDefined();
    const request = plane.reviewPool.getRequest(result.reviewRequest!.id);
    expect(plane.reviewPool.listSlots(request.id)).toHaveLength(2);
    expect(plane.organization.listWorkItems(mission.id)).toHaveLength(3);
    expect(Number(database.db.prepare('SELECT COUNT(*) AS count FROM organization_review_work_items').get()?.count)).toBe(2);

    const repeated = plane.organizationWorkflow.reconcileVerifiedWork(
      checkedClaim, verification, workspace(repo, baseSha), 101,
    );
    expect(repeated.status).toBe('review-ready');
    expect(plane.organization.listWorkItems(mission.id)).toHaveLength(3);
    expect(Number(database.db.prepare('SELECT COUNT(*) AS count FROM organization_review_work_items').get()?.count)).toBe(2);

    const reviewerIds = (database.db.prepare('SELECT DISTINCT reviewer_agent_id FROM organization_review_work_items WHERE review_request_id=? ORDER BY reviewer_agent_id').all(request.id) as Array<{ reviewer_agent_id: string }>).map((row) => row.reviewer_agent_id);
    expect(reviewerIds).toHaveLength(2);
    for (const [index, slot] of plane.reviewPool.listSlots(request.id).entries()) {
      const reviewer = plane.organization.getAgent(reviewerIds[index]!);
      plane.reviewPool.claim({ slotId: slot.id, reviewerAgentId: reviewer.id }, 200 + index);
      const decision = plane.reviewPool.decide({
        slotId: slot.id, reviewerAgentId: reviewer.id,
        decision: 'approve', note: 'Inspected exact candidate and evidence',
      }, 210 + index);
      if (decision.request.status === 'approved') {
        plane.organizationWorkflow.reconcileReviewDecision(request.id, 220 + index);
      }
    }
    expect(git(repo, 'rev-parse', 'refs/heads/main')).toBe(headSha);
    expect(Number(database.db.prepare("SELECT COUNT(*) AS count FROM organization_review_work_items WHERE status='completed'").get()?.count)).toBe(2);
  }, 60_000);
});
