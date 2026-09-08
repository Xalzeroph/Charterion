import { readdir, readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'shared/architecture-boundaries.json');

function fail(message) {
  throw new Error(`LAYER_BOUNDARY_ERROR ${message}`);
}

function normalized(path) {
  return relative(root, path).replaceAll('\\', '/');
}

function globRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function relativeImports(text) {
  return [...text.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
}

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1) fail('architecture manifest schemaVersion must be 1');
if (!Array.isArray(manifest.sourceRoots) || manifest.sourceRoots.length === 0) fail('sourceRoots must be non-empty');

const files = (await Promise.all(manifest.sourceRoots.map((dir) => collect(resolve(root, dir))))).flat();
const textByPath = new Map();
for (const file of files) textByPath.set(normalized(file), await readFile(file, 'utf8'));

for (const rule of manifest.exclusiveTokens ?? []) {
  if (typeof rule.token !== 'string' || !rule.token) fail('exclusive token must be non-empty');
  const owners = new Set(rule.owners ?? []);
  if (owners.size === 0) fail(`exclusive token ${rule.token} has no owners`);
  const locations = [...textByPath.entries()].filter(([, text]) => text.includes(rule.token)).map(([path]) => path);
  const escaped = locations.filter((path) => !owners.has(path));
  if (escaped.length > 0) fail(`${rule.reason ?? rule.token} Escaped owners: ${escaped.join(', ')}`);
}

for (const rule of manifest.importQuarantines ?? []) {
  if (typeof rule.module !== 'string' || !rule.module) fail('quarantined module must be non-empty');
  const owners = new Set(rule.owners ?? []);
  const escaped = [];
  for (const [path, text] of textByPath) {
    if (!relativeImports(text).includes(rule.module)) continue;
    if (!owners.has(path)) escaped.push(path);
  }
  if (escaped.length > 0) fail(`${rule.reason ?? rule.module} Escaped importers: ${escaped.join(', ')}`);
}

for (const rule of manifest.forbiddenImports ?? []) {
  const source = globRegex(rule.sourcePattern);
  const targets = new Set(rule.targetBasenames ?? []);
  for (const [path, text] of textByPath) {
    if (!source.test(path)) continue;
    for (const imported of relativeImports(text)) {
      const target = basename(imported).replace(/\.(?:ts|js|mjs|cjs)$/, '');
      if (targets.has(target)) fail(`${rule.reason ?? 'Forbidden dependency'} ${path} -> ${imported}`);
    }
  }
}

for (const rule of manifest.fileLineBudgets ?? []) {
  const text = textByPath.get(rule.path) ?? await readFile(resolve(root, rule.path), 'utf8').catch(() => undefined);
  if (text === undefined) fail(`budgeted file is missing: ${rule.path}`);
  const lines = text.split(/\r?\n/).length;
  if (!Number.isInteger(rule.maxLines) || rule.maxLines < 1) fail(`invalid line budget for ${rule.path}`);
  if (lines > rule.maxLines) fail(`${rule.reason ?? 'File line budget exceeded'} ${rule.path}: ${lines} > ${rule.maxLines}`);
}

console.log(`LAYER_BOUNDARY_CHECK_PASS files=${files.length} exclusive=${(manifest.exclusiveTokens ?? []).length} quarantines=${(manifest.importQuarantines ?? []).length}`);
