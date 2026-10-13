/**
 * Every local (file:) dependency in package.json ships in both release
 * packages. In a checkout npm links such a dependency to its folder in this
 * repository, but neither package carries the repository along:
 * - the npm package publishes package.json's "files" only: the folder has to
 *   be there, and the dependency bundled (bundleDependencies), or a user's
 *   install links it to a folder that doesn't exist;
 * - the MCPB bundle (scripts/build-mcpb.cjs) copies a fixed list of files and
 *   runs npm install in the bundle: the folder has to be on that list, and
 *   installed with --install-links so the bundle holds real files, not a link.
 *
 * Reads package.json and build-mcpb.cjs only: no build, no network.
 * test/repro/test-release-packages-ship-contract.js builds both packages.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A folder as package.json and the copy list write it: a/b/c */
const folder = (value) => path.posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');
/** True when the listed folder is dir or one of its parents */
const covers = (listed, dir) => dir === listed || dir.startsWith(`${listed}/`);

async function runTests() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const local = Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:'))
    .map(([name, spec]) => ({ name, dir: folder(spec.slice('file:'.length)) }));
  const files = (pkg.files ?? []).map(folder);
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? [];

  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-mcpb.cjs'), 'utf8');
  const copyList = build.match(/const filesToCopy = \[([\s\S]*?)\];/);
  assert.ok(copyList, 'scripts/build-mcpb.cjs has no filesToCopy list');
  const copied = [...copyList[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => folder(match[1]));
  const install = build.match(/execSync\(\s*['"`](npm install[^'"`]*)['"`]/);
  assert.ok(install, 'scripts/build-mcpb.cjs has no npm install for the bundle');

  const missing = [];
  for (const { name, dir } of local) {
    if (!files.some((listed) => covers(listed, dir))) missing.push(`npm: ${dir} is not in package.json "files"`);
    if (!bundled.includes(name)) missing.push(`npm: ${name} is not in bundleDependencies`);
    if (!copied.some((listed) => covers(listed, dir))) missing.push(`MCPB: ${dir} is not in build-mcpb.cjs's filesToCopy`);
  }
  if (local.length > 0 && !/--install-links\b/.test(install[1])) {
    missing.push(`MCPB: the bundle's "${install[1]}" links ${local.map(({ name }) => name).join(', ')} instead of copying it (no --install-links)`);
  }

  assert.deepEqual(missing, [], `local dependencies the release packages leave out:\n  ${missing.join('\n  ')}`);
  console.log(`✅ PASS  local dependencies ship in the npm package and the MCPB bundle: ${local.map(({ name }) => name).join(', ') || 'none'}`);
}

runIfMain(import.meta.url, runTests);
