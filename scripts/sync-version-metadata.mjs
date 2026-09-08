import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');

function fail(message) {
  throw new Error(`VERSION_METADATA_ERROR ${message}`);
}

function semver(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    fail(`package.json version is not valid semver: ${String(value)}`);
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function syncJson(path, mutate) {
  const raw = await readFile(path, 'utf8');
  const value = JSON.parse(raw);
  mutate(value);
  const next = stableJson(value);
  if (check) {
    if (raw.replaceAll('\r\n', '\n') !== next) fail(`${path} is stale; run npm run sync:version-metadata`);
    return false;
  }
  if (raw.replaceAll('\r\n', '\n') === next) return false;
  await writeFile(path, next, 'utf8');
  return true;
}

async function syncReadme(path, version) {
  const raw = await readFile(path, 'utf8');
  const badgeVersion = version.replaceAll('-', '--');
  const badge = `[![Version](https://img.shields.io/badge/version-${badgeVersion}-2ea44f.svg)](manifest.json)`;
  const pattern = /^\[!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-[^\r\n]+-2ea44f\.svg\)\]\(manifest\.json\)$/m;
  const matches = raw.match(new RegExp(pattern.source, 'gm')) ?? [];
  if (matches.length !== 1) fail(`${path} must contain exactly one canonical Version badge`);
  const next = raw.replace(pattern, badge);
  if (check) {
    if (next !== raw) fail(`${path} version badge is stale; run npm run sync:version-metadata`);
    return false;
  }
  if (next === raw) return false;
  await writeFile(path, next, 'utf8');
  return true;
}

const packagePath = resolve(root, 'package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const version = semver(pkg.version);

const changed = [];
if (await syncJson(resolve(root, 'package-lock.json'), (lock) => {
  lock.version = version;
  if (!lock.packages || typeof lock.packages !== 'object' || !lock.packages['']) fail('package-lock.json is missing packages[""]');
  lock.packages[''].version = version;
})) changed.push('package-lock.json');

if (await syncJson(resolve(root, 'manifest.json'), (manifest) => {
  manifest.version = version;
})) changed.push('manifest.json');

const readmes = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && (entry.name === 'README.md' || /^README\..+\.md$/.test(entry.name)))
  .map((entry) => entry.name)
  .sort();
if (readmes.length === 0) fail('no README files found');
for (const name of readmes) {
  if (await syncReadme(resolve(root, name), version)) changed.push(name);
}

console.log(check
  ? `VERSION_METADATA_CHECK_PASS version=${version} readmes=${readmes.length}`
  : `VERSION_METADATA_SYNC_PASS version=${version} changed=${changed.length}`);
