import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ControlDatabase } from '../src/database';
import { ControlPlane } from '../src/controlPlane';

const cleanups: Array<() => void> = [];
function harness(): ControlPlane {
  const dir = mkdtempSync(join(tmpdir(), 'charterion-auto-intake-'));
  const database = new ControlDatabase(join(dir, 'global.db'));
  cleanups.push(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  return new ControlPlane(database);
}
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe('AutonomousIntakeAuthority', () => {
  it('bootstraps organization execution from one task and replays idempotently', () => {
    const plane = harness();
    const org = plane.organization.createOrganization({ name: 'Noetrium Organization' }, 10);
    const project = plane.createProject({ name: 'Noetrium', rootPath: join(tmpdir(), 'noetrium'), minSlots: 0, maxSlots: 4, weight: 1 });
    const first = plane.autonomousIntake.submit({
      organizationId: org.id,
      projectId: project.id,
      objective: 'Implement the next-generation autonomous organization lifecycle',
      idempotencyKey: 'noetrium-next-gen-1',
    }, 20);
    expect(first.request.status).toBe('accepted');
    expect(first.mission.status).toBe('active');
    expect(first.workItem.ownerAgentId).toBe(first.dri.id);
    expect(first.workspace.status).toBe('ready');
    expect(first.runtime.status).toBe('acquired');
    expect(first.projection.task.organizationWorkItemId).toBe(first.workItem.id);

    const replay = plane.autonomousIntake.submit({
      organizationId: org.id,
      projectId: project.id,
      objective: 'Implement the next-generation autonomous organization lifecycle',
      idempotencyKey: 'noetrium-next-gen-1',
    }, 21);
    expect(replay.request.id).toBe(first.request.id);
    expect(replay.mission.id).toBe(first.mission.id);
    expect(replay.workItem.id).toBe(first.workItem.id);
    expect(replay.dri.id).toBe(first.dri.id);
    expect(replay.projection.managerTaskId).toBe(first.projection.managerTaskId);
    expect(plane.organization.listAgents(org.id)).toHaveLength(1);
  });
});
