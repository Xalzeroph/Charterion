import { ensureAdminToken, ensureBrowserToken, resolveDaemonConfig } from './config';
import { ControlDatabase } from './database';
import { ControlPlane } from './controlPlane';
import { startIpcServer } from './ipc';
import { RpcRouter } from './rpc';

async function main(): Promise<void> {
  const config = resolveDaemonConfig();
  const adminToken = ensureAdminToken(config);
  const browserToken = ensureBrowserToken(config);
  const database = new ControlDatabase(config.databasePath);
  const plane = new ControlPlane(database, config.gitPath);
  const recoveredOrganizationWorkflows = plane.reconcilePersistedOrganizationWorkflows();
  if (recoveredOrganizationWorkflows > 0) console.error(`gamd recovered organization workflows=${recoveredOrganizationWorkflows}`);
  const router = new RpcRouter(plane, adminToken, browserToken, config.instanceId);
  const server = await startIpcServer(config.pipeName, router);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => {
      database.close();
    });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('uncaughtException', (error) => {
    console.error(error);
    close();
  });
  console.error(`gamd ready instance=${config.instanceId} pipe=${config.pipeName}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
