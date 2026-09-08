import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcRoot = resolve(root, 'src');
const controlSrcRoot = resolve(root, 'control/src');

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

const files = await sourceFiles(srcRoot);
const controlFiles = await sourceFiles(controlSrcRoot);
const textByFile = new Map();
for (const file of files) textByFile.set(file, await readFile(file, 'utf8'));

const background = textByFile.get(resolve(srcRoot, 'background.ts')) ?? '';
const backgroundLines = background.split(/\r?\n/).length;
const directCreate = background.indexOf("chrome.tabs.create({ url: action.url, active: false })");
const placeholderCreate = background.indexOf("chrome.tabs.create({ url: 'about:blank', active: false })");
const fleetBind = background.indexOf('await updateBinding(tab.id', directCreate);
if (directCreate < 0 || fleetBind < 0 || placeholderCreate >= 0 || !(directCreate < fleetBind)) {
  throw new Error('Fleet tabs must navigate directly to ChatGPT without an untracked about:blank placeholder');
}

for (const required of [
  'new TabOperationQueue()',
  'new CoalescingRunner(',
  'new ContentRuntimeFence()',
  'controlFeedbackMessages(snapshot',
]) {
  if (!background.includes(required)) throw new Error(`background coordinator lost required boundary: ${required}`);
}
if (/\blet\s+supervisorRun\s*:/.test(background)) throw new Error('Legacy drop-on-busy Supervisor runner returned');
if (/\blet\s+fleetReconcileRun\s*:/.test(background)) throw new Error('Legacy drop-on-busy fleet reconciler returned');

const policy = textByFile.get(resolve(srcRoot, 'browserOperationPolicy.ts')) ?? '';
for (const operation of [
  'page.snapshot', 'prompt.send', 'tab.open', 'tab.close', 'binding.update', 'runtime.observe',
]) {
  if (!policy.includes(`'${operation}'`)) throw new Error(`Browser operation manifest is missing ${operation}`);
}
if (!policy.includes("'prompt.send': { operation: 'prompt.send', operationClass: 'write', retryPolicy: 'never'")) {
  throw new Error('prompt.send must remain a non-auto-retryable physical browser write');
}

const attempts = textByFile.get(resolve(srcRoot, 'attempts.ts')) ?? '';
if (!attempts.includes("uncertain: new Set(['reply-observed'])")) {
  throw new Error('uncertain delivery must not become auto-retryable or acknowledged later');
}
const adapter = textByFile.get(resolve(srcRoot, 'chatgptAdapter.ts')) ?? '';
if (!adapter.includes("!/^WEB:/i.test(decoded)")) throw new Error('Temporary WEB conversation ids must not become durable bindings');
const fleet = textByFile.get(resolve(srcRoot, 'fleet.ts')) ?? '';
if (!fleet.includes("/^WEB:/i.test(id)") || !fleet.includes("return 'https://chatgpt.com/'")) throw new Error('Fleet resume must reject temporary WEB conversation ids');
if (!fleet.includes("agent.browserState === 'opening'") || !fleet.includes("kind: 'report-absent'")) {
  throw new Error('Fleet opening reservation fence is missing');
}
if (!fleet.includes("agent.rolloverState !== 'idle'")) throw new Error('Rollover workers must remain excluded from normal task dispatch');

const controlPlane = await readFile(resolve(root, 'control/src/controlPlane.ts'), 'utf8');
if (!controlPlane.includes('canonicalConversationKey(input.conversationKey)') || !controlPlane.includes("/^WEB:/i.test(id)")) {
  throw new Error('Kernel canonical conversation authority fence is missing');
}
for (const fence of ['Stale agent browser observation', 'Stale browser runtime observation']) {
  if (!controlPlane.includes(fence)) throw new Error(`Kernel observation fence missing: ${fence}`);
}

const rpcParams = await readFile(resolve(root, 'control/src/rpcParams.ts'), 'utf8');
const organizationRpc = await readFile(resolve(root, 'control/src/organizationRpc.ts'), 'utf8');
const rpc = await readFile(resolve(root, 'control/src/rpc.ts'), 'utf8');
if (organizationRpc.includes("'org-agent.bind-runtime'") || organizationRpc.includes("'org-agent.unbind-runtime'")) {
  throw new Error('Organization runtime binding must go through acquisition authority');
}
if (rpcParams.includes('ControlPlane') || rpcParams.includes('OrganizationRpcController')) {
  throw new Error('RPC parameter contracts must remain independent of business controllers');
}
for (const helper of ['record', 'stringParam', 'numberParam', 'objectParam', 'objectArrayParam', 'enumParam']) {
  if (rpc.includes('function ' + helper)) throw new Error('RPC parameter helper leaked back into router: ' + helper);
}

const protocolManifest = JSON.parse(await readFile(resolve(root, 'shared/native-rpc-protocol.json'), 'utf8'));
if (protocolManifest.schemaVersion !== 1 || !Array.isArray(protocolManifest.methods) || protocolManifest.methods.length === 0) {
  throw new Error('Native RPC protocol manifest is missing or invalid');
}
const nativeHost = await readFile(resolve(root, 'native-host/GamNativeHost/Program.cs'), 'utf8');
if (!nativeHost.includes('NativeRpcProtocol.AllowedMethods') || !nativeHost.includes('NativeRpcProtocol.MaxMessageBytes')) {
  throw new Error('Native Host must consume the generated NativeRpcProtocol contract');
}
if (nativeHost.includes('new HashSet<string>') || protocolManifest.methods.some((method) => nativeHost.includes(`"${method.name}"`))) {
  throw new Error('Native Host must not duplicate protocol method declarations');
}
const persistentNative = textByFile.get(resolve(srcRoot, 'nativeControlPersistent.ts')) ?? '';
if (!persistentNative.includes("from './nativeRpcProtocol.generated'")) {
  throw new Error('Persistent native adapter must consume the generated protocol contract');
}

const database = await readFile(resolve(root, 'control/src/database.ts'), 'utf8');
const schemaVersion = Number(database.match(/CONTROL_SCHEMA_VERSION = (\d+)/)?.[1]);
if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error('Control schema version declaration is missing or invalid');
for (const token of ['agent_conversations', 'worker_checkpoints', 'agent_rollovers', 'self_hosting_promotions', 'organization_runtime_acquisitions']) {
  if (!database.includes(token)) throw new Error(`Control schema fence missing: ${token}`);
}
const migrationVersions = [...database.matchAll(/private migrateV(\d+)\(\):/g)].map((match) => Number(match[1]));
const expectedMigrations = Array.from({ length: schemaVersion }, (_, index) => index + 1);
if (migrationVersions.length !== expectedMigrations.length || migrationVersions.some((version, index) => version !== expectedMigrations[index])) {
  throw new Error('Control schema migration chain is not contiguous through the declared version');
}

const conversationAuthority = await readFile(resolve(root, 'control/src/conversationAuthority.ts'), 'utf8');
if (!conversationAuthority.includes("operation.outcome !== 'reply-observed'")) {
  throw new Error('Kernel rollover completion lost reply-evidence authority');
}
const rolloverRuntime = textByFile.get(resolve(srcRoot, 'conversationRollover.ts')) ?? '';
for (const token of ['GAM CONVERSATION ROLLOVER HANDOFF', 'conversationLimitRetryTransition', 'bootstrapPendingConversationRollover']) {
  if (!rolloverRuntime.includes(token)) throw new Error(`Conversation rollover runtime fence missing: ${token}`);
}

console.log(`Architecture semantic checks passed (${files.length} src files; ${controlFiles.length} control files; background ${backgroundLines} lines).`);
