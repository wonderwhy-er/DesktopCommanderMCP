/** Exercise the producer's declared file inventory, not a full checkout which hides missing imports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jobLines, readWorkflow } from './helpers/workflow-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const denyExternal = `import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url);
const denied=()=>{throw new Error('Sparse producer test forbids network/Git/gh/provider access');};
for(const [module,names] of [
 ['node:child_process',['spawn','spawnSync','exec','execFile','execFileSync']],
 ['node:http',['request','get','createServer']],['node:https',['request','get']],
 ['node:net',['connect','createConnection','createServer']],['node:tls',['connect']],
 ['node:dns',['lookup','resolve']],
])for(const name of names)require(module)[name]=denied;
globalThis.fetch=denied;syncBuiltinESMExports();
`;

function inventory(lines) {
  const marker = lines.findIndex(line => line.trim() === 'sparse-checkout: |');
  assert.ok(marker >= 0, 'the launched CLI job declares a sparse checkout');
  const indent = lines[marker].search(/\S/);
  const files = [];
  for (const line of lines.slice(marker + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    if (line.trim()) files.push(line.trim().replace(/^\//, ''));
  }
  assert.ok(files.includes('test/ci-review.js'), 'test the real CLI inventory');
  return files;
}

function loadSparseRequest(files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sparse-test-'));
  try {
    for (const file of files) {
      assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
      const target = path.join(folder, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), target);
    }
    const guard = path.join(folder, 'deny-external.mjs');
    fs.writeFileSync(guard, denyExternal);
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    Object.assign(env, { CALLED_SHA: HEAD, CALLED_BASE: BASE, CALLED_PR: '7',
      GITHUB_REPOSITORY: 'fixture/offline', GITHUB_OUTPUT: path.join(folder, 'output.txt') });
    return spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, 'test/ci-review.js', 'request'], {
      cwd: folder, env, encoding: 'utf8', timeout: 10_000,
    });
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  }
}

for (const name of ['tests.yml', 'review.yml']) {
  const workflow = readWorkflow(name);
  const jobsText = workflow.slice(workflow.indexOf('\njobs:\n'));
  const jobs = [...jobsText.matchAll(/^  ([\w-]+):\s*$/gm)].map(match => match[1]);
  for (const job of jobs) {
    const lines = jobLines(jobsText, job);
    if (!lines.some(line => /node test\/ci-review\.js (request|run|post)/.test(line))) continue;
    test(`${name} ${job}: the declared sparse files load the review CLI with external access denied`, () => {
      const result = loadSparseRequest(inventory(lines));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^review=true$/m);
      assert.ok(result.stdout.includes(`sha=${HEAD}`));
      assert.ok(result.stdout.includes(`base=${BASE}`));
    });
  }
}
