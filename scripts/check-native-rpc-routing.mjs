import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

const [
  manifestText, rpc, rpcLegacy, organizationRpc, persistent, legacy, facade,
  installPs, uninstallPs, runtimeSmokePs,
] = await Promise.all([
  read('shared/native-rpc-protocol.json'),
  read('control/src/rpc.ts'),
  read('control/src/rpcLegacy.ts'),
  read('control/src/organizationRpc.ts'),
  read('src/nativeControlPersistent.ts'),
  read('src/nativeControlLegacy.ts'),
  read('src/nativeControl.ts'),
  read('native-host/scripts/install.ps1'),
  read('native-host/scripts/uninstall.ps1'),
  read('scripts/smoke-runtime-install.ps1'),
]);

const manifest = JSON.parse(manifestText);
const declared = new Set(manifest.methods.map((method) => method.name));
const routed = new Set(['health']);
for (const source of [rpc, rpcLegacy, organizationRpc]) {
  for (const match of source.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)) routed.add(match[1]);
  for (const match of source.matchAll(/request(?:\?\.|\.)method\s*!==\s*['"]([^'"]+)['"]/g)) routed.add(match[1]);
  for (const match of source.matchAll(/request(?:\?\.|\.)method\s*===\s*['"]([^'"]+)['"]/g)) routed.add(match[1]);
}

const unrouted = [...declared].filter((method) => !routed.has(method));
if (unrouted.length > 0) {
  throw new Error(`NATIVE_RPC_ROUTING_ERROR manifest methods have no Kernel route: ${unrouted.join(', ')}`);
}

const persistentMethods = new Set();
for (const match of persistent.matchAll(/persistentNativeResult\(\s*['"]([^'"]+)['"]/g)) persistentMethods.add(match[1]);
for (const match of persistent.matchAll(/method:\s*['"]([^'"]+)['"]\s+as const/g)) persistentMethods.add(match[1]);
const undeclaredPersistent = [...persistentMethods].filter((method) => !declared.has(method));
if (undeclaredPersistent.length > 0) {
  throw new Error(`NATIVE_RPC_ROUTING_ERROR persistent adapter uses undeclared methods: ${undeclaredPersistent.join(', ')}`);
}

const legacyAsyncExports = new Set([...legacy.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]));
const persistentAsyncExports = new Set([...persistent.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]));
const missingPersistent = [...legacyAsyncExports].filter((name) => !persistentAsyncExports.has(name));
if (missingPersistent.length > 0) {
  throw new Error(`NATIVE_RPC_ROUTING_ERROR legacy native operations are not covered by persistent adapter: ${missingPersistent.join(', ')}`);
}

const missingFacade = [...persistentAsyncExports].filter((name) => !new RegExp(`\\b${name}\\b`).test(facade));
if (missingFacade.length > 0) {
  throw new Error(`NATIVE_RPC_ROUTING_ERROR persistent native operations are not exported by facade: ${missingFacade.join(', ')}`);
}

for (const [path, text] of [
  ['native-host/scripts/install.ps1', installPs],
  ['native-host/scripts/uninstall.ps1', uninstallPs],
  ['scripts/smoke-runtime-install.ps1', runtimeSmokePs],
]) {
  if (!text.includes('NativeRpcProtocol.generated.ps1')) {
    throw new Error(`NATIVE_RPC_ROUTING_ERROR ${path} must consume generated PowerShell protocol constants`);
  }
  if (text.includes(`'${manifest.host}'`) || text.includes(`"${manifest.host}"`)) {
    throw new Error(`NATIVE_RPC_ROUTING_ERROR ${path} duplicates native host identity instead of consuming generated protocol`);
  }
}

console.log(`NATIVE_RPC_ROUTING_CHECK_PASS declared=${declared.size} routed=${routed.size} persistent=${persistentAsyncExports.size}`);
