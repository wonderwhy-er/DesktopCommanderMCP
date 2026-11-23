import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildGraph, changedFiles, selectTests } from './helpers/select-tests.js';

test('the unit checkout keeps the history needed by changed:A..B', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ci-history-'));
  // Every clone has an owned local bare origin. No other Git transport is allowed.
  const git = (cwd, ...args) => execFileSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args,
  ], {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    git(source, 'init', '--quiet');
    for (const [file, text] of Object.entries({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'test/test-a.js': "import { a } from '../dist/a.js';\n",
      'test/test-b.js': "import { b } from '../dist/b.js';\n",
    })) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.writeFileSync(path.join(source, file), text);
    }
    git(source, 'add', '.');
    git(source, 'commit', '--quiet', '-m', 'A');
    const from = git(source, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(source, 'src/a.ts'), 'export const a = 2;\n');
    git(source, 'commit', '--quiet', '-am', 'B');
    const to = git(source, 'rev-parse', 'HEAD');
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '--quiet', '--bare', '--no-local', source, origin);
    const originUrl = pathToFileURL(origin).href;
    const shallow = path.join(root, 'shallow');
    git(root, 'clone', '--quiet', '--depth=1', originUrl, shallow);
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true');
    assert.throws(() => changedFiles({ root: shallow, from, to }), /bad object|bad revision|unknown revision/i,
      'the default depth-one checkout cannot compare A..B');

    const full = path.join(root, 'full');
    git(root, 'clone', '--quiet', originUrl, full);
    assert.equal(git(full, 'rev-parse', '--is-shallow-repository'), 'false');
    const changes = changedFiles({ root: full, from, to });
    assert.deepEqual(changes, [{ file: 'src/a.ts', uncommitted: false }]);
    const selected = selectTests({
      tests: ['test/test-a.js', 'test/test-b.js'],
      changed: changes.map(({ file }) => file), graph: buildGraph({ root: full, commit: to }),
    });
    assert.equal(selected.runAll, null);
    assert.deepEqual([...selected.picked.keys()], ['test/test-a.js']);
    assert.deepEqual(selected.unreached, []);

    const workflow = fs.readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
    const unit = workflow.match(/^  unit:\r?\n([\s\S]*?)(?=^  [a-z][\w-]*:|$(?![\s\S]))/m)?.[1];
    const checkout = unit?.match(/      - name: Checkout\r?\n([\s\S]*?)(?=      - name:)/)?.[1];
    assert.ok(checkout?.includes('uses: actions/checkout@'), 'check the unit job checkout');
    assert.match(checkout, /^          fetch-depth: 0\s*$/m,
      'the tested-code checkout must fetch A as well as B for changed:A..B');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
