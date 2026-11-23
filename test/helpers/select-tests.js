import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { ROOT } from './node-test-runner.js';

/**
 * Picks the test files a change can affect, for `--changed [A [B]]` in the runners:
 * a test file is picked when a changed file is in its reach.
 *
 * The reach comes from the import graph of src/, test/, scripts/ and the root
 * scripts: static imports, require() and import('…') with a literal, read with
 * TypeScript's preProcessFile. Imports of dist/x.js count as src/x.ts
 * (tsconfig.json: rootDir src, outDir dist). Three more links no import shows:
 * - paths into dist/ written as strings in test files: the server the helpers
 *   start (dist/index.js), pathToFileURL(path.join(…, 'dist', …));
 * - src/ui/<app>/ is bundled into dist/ui/ and read by path through src/ui/resources.ts;
 * - a file a test names by its file name: a data file, a fixture or a script
 *   it starts by its path, a preload it passes to --import.
 *
 * Some changes reach every test: package.json, the lockfile, a tsconfig, the
 * runners and their helpers. Then everything runs, and so it does for a changed
 * file in src/ or test/helpers/ the graph doesn't know.
 */

const CODE = /\.(ts|js|mjs|cjs)$/;
// The PowerShell tests: no imports, only text naming the files they check; this test runs them all
const POWERSHELL_TEST = /^test\/[^/]+\.test\.ps1$/;
const POWERSHELL_TESTS = 'test/test-powershell-tests.js';
const RUN_EVERYTHING = [
  /^package(-lock)?\.json$/,
  /^tsconfig.*\.json$/,
  /^scripts\/build-ui-runtime\.cjs$/,
  /^test\/run-all-tests\.js$/,
  /^test\/repro\/run-repro\.js$/,
  /^test\/integration\/run-all-integration-tests\.js$/,
  /^test\/docker\/run-docker-tests\.js$/,
  /^test\/helpers\/(node-test-runner|test-home|test-env|select-tests)\.js$/,
];
const NO_TESTS = [/\.md$/, /^docs\//, /\.(png|jpe?g|gif|mp4|svg)$/, /^\.github\//, /^LICENSE/];
// The build copies these root scripts into dist/
const COPIED_TO_DIST = {
  'dist/setup-claude-server.js': 'setup-claude-server.js',
  'dist/uninstall-claude-server.js': 'uninstall-claude-server.js',
  'dist/track-installation.js': 'track-installation.js',
};

const toPosix = (file) => file.split(path.sep).join('/');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Where HEAD left origin/main (or main), the base `--changed` uses when given none */
export function defaultBase(root = ROOT) {
  for (const branch of ['origin/main', 'main']) {
    try {
      return git(root, 'merge-base', branch, 'HEAD');
    } catch {
      // that branch isn't here: try the next
    }
  }
  throw new Error('--changed: no origin/main or main to compare with; give a base, e.g. --changed HEAD~1');
}

/**
 * The changed files, sorted, each { file, uncommitted }:
 * - from and to: what changed between the two commits, nothing else;
 * - from only: the commits since it, plus uncommitted changes and new files,
 *   which are marked uncommitted.
 */
export function changedFiles({ root = ROOT, from, to }) {
  if (to) return lines(git(root, 'diff', '--name-only', from, to)).sort().map((file) => ({ file, uncommitted: false }));
  const uncommitted = new Set([
    ...lines(git(root, 'diff', '--name-only', 'HEAD')),
    ...lines(git(root, 'ls-files', '--others', '--exclude-standard')),
  ]);
  const files = new Set([...lines(git(root, 'diff', '--name-only', from, 'HEAD')), ...uncommitted]);
  return [...files].sort().map((file) => ({ file, uncommitted: uncommitted.has(file) }));
}

// The files the graph reads: code in src/, test/, scripts/ and at the root, not built or hidden
const inGraph = (file) => CODE.test(file) && !file.endsWith('.d.ts')
  && !/(^|\/)(node_modules|dist)\//.test(file) && !/(^|\/)\./.test(file)
  && (/^(src|test|scripts)\//.test(file) || !file.includes('/'));

function walk(root, dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else if (CODE.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(toPosix(path.relative(root, full)));
  }
  return out;
}

/** The graph's files and their text: the checkout's, or a commit's, read through git */
function readFiles(root, commit) {
  if (!commit) {
    const testDir = path.join(root, 'test');
    const powerShellTests = fs.existsSync(testDir) ? fs.readdirSync(testDir).map((file) => `test/${file}`).filter((file) => POWERSHELL_TEST.test(file)) : [];
    const files = [
      ...walk(root, path.join(root, 'src')),
      ...walk(root, testDir),
      ...walk(root, path.join(root, 'scripts')),
      ...fs.readdirSync(root).filter((file) => CODE.test(file)),
      ...powerShellTests,
    ];
    return new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  }
  const files = lines(git(root, 'ls-tree', '-r', '--name-only', commit)).filter((file) => inGraph(file) || POWERSHELL_TEST.test(file));
  // One git process for every file: "<sha> blob <size>\n<content>\n" each
  const input = files.map((file) => `${commit}:${file}\n`).join('');
  const output = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input, maxBuffer: 256 * 1024 * 1024 }).stdout;
  const texts = new Map();
  let at = 0;
  for (const file of files) {
    const headerEnd = output.indexOf(0x0a, at);
    const size = Number(output.subarray(at, headerEnd).toString().split(' ')[2]);
    texts.set(file, output.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8'));
    at = headerEnd + 1 + size + 1;
  }
  return texts;
}

/**
 * The import graph: each file and the files it reaches in one step. Read from the
 * checkout, or with `commit` from that commit through git, whatever is checked out.
 */
export function buildGraph({ root = ROOT, commit } = {}) {
  const sources = readFiles(root, commit);
  const files = [...sources.keys()];
  const fileSet = new Set(files);

  const fromDist = (distFile) => {
    if (COPIED_TO_DIST[distFile]) return COPIED_TO_DIST[distFile];
    const inSrc = `src/${distFile.slice('dist/'.length)}`;
    return [inSrc.replace(/\.js$/, '.ts'), inSrc, inSrc.replace(/\.js$/, '/index.ts')].find((file) => fileSet.has(file));
  };
  const resolveImport = (fromFile, specifier) => {
    if (!specifier.startsWith('.')) return undefined; // packages: a lockfile change runs everything
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    if (target.startsWith('dist/')) return fromDist(target);
    const stem = target.replace(/\.(js|mjs|cjs)$/, '');
    return [target, `${stem}.ts`, `${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${target}/index.ts`, `${target}/index.js`]
      .find((file) => fileSet.has(file));
  };

  const edges = new Map();
  const texts = new Map();
  for (const [file, text] of sources) {
    if (POWERSHELL_TEST.test(file)) {
      texts.set(file, text);
      edges.set(file, new Set());
      continue;
    }
    const reached = new Set();
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      const target = resolveImport(file, fileName);
      if (target) reached.add(target);
    }
    if (file.startsWith('test/')) {
      texts.set(file, text);
      for (const target of distPathsIn(text, fromDist)) reached.add(target);
    }
    edges.set(file, reached);
  }
  // test-powershell-tests.js runs every test/*.test.ps1, so a file one names reaches it
  if (edges.has(POWERSHELL_TESTS)) for (const ps1 of files.filter((file) => POWERSHELL_TEST.test(file))) edges.get(POWERSHELL_TESTS).add(ps1);
  return { files, fileSet, edges, texts };
}

/** Files under dist/ a test names in strings: 'dist/a/b.js', path.join(…, 'dist', 'a', 'b.js'), a helper's 'a/b.js' */
function distPathsIn(text, fromDist) {
  if (!/dist/.test(text)) return [];
  const literals = [...text.matchAll(/['"`]([^'"`\n]*)['"`]/g)].map((match) => match[1]);
  const found = [];
  literals.forEach((literal, i) => {
    let distFile;
    const direct = literal.match(/(?:^|\/)dist\/([\w./-]+\.js)$/);
    if (direct) distFile = `dist/${direct[1]}`;
    else if (literal === 'dist') {
      const parts = [];
      for (let j = i + 1; j < literals.length && j < i + 5 && /^[\w.-]+$/.test(literals[j]); j++) {
        parts.push(literals[j]);
        if (literals[j].endsWith('.js')) break;
      }
      if (parts.at(-1)?.endsWith('.js')) distFile = `dist/${parts.join('/')}`;
    } else if (/^[\w./-]+\.js$/.test(literal) && !literal.startsWith('.')) {
      distFile = `dist/${literal}`;
    }
    const target = distFile && fromDist(distFile);
    if (target) found.push(target);
  });
  return found;
}

/** Every file a test reaches, each with the file it was reached from */
function reach(edges, start) {
  const from = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const next of edges.get(file) ?? []) {
      if (!from.has(next)) {
        from.set(next, file);
        queue.push(next);
      }
    }
  }
  return from;
}

/**
 * Links no import shows, from a changed file to the files that use it. A file a
 * test names by its file name uses it: a data file, a fixture or a script it
 * starts by its path, a preload it passes to --import.
 */
function otherLinks(file, texts) {
  const links = [];
  if (/^src\/ui\/[^/]+\//.test(file) && !file.startsWith('src/ui/shared/')) links.push('src/ui/resources.ts');
  const name = path.posix.basename(file);
  const startedByPath = !CODE.test(name) || file.startsWith('test/fixtures/') || file.startsWith('scripts/');
  if (startedByPath && name.length > 6) {
    for (const [testFile, text] of texts) if (testFile !== file && text.includes(name)) links.push(testFile);
  }
  return links;
}

// Changed files that should reach some test: listed when none does
const NEEDS_A_TEST = /^(src|scripts|test\/fixtures|test\/helpers)\//;

/**
 * Which of `tests` (paths from the repository root) the changed files reach.
 * Returns { runAll, picked: Map(test → chain from the test to the changed file), unreached }.
 */
export function selectTests({ tests, changed, graph = buildGraph() }) {
  const reached = new Map(tests.map((test) => [test, reach(graph.edges, test)]));
  const picked = new Map();
  const unreached = [];
  let runAll = null;
  for (const file of changed) {
    if (RUN_EVERYTHING.some((rule) => rule.test(file))) {
      runAll ??= file;
      continue;
    }
    if (NO_TESTS.some((rule) => rule.test(file))) continue;
    const links = otherLinks(file, graph.texts);
    if (!graph.fileSet.has(file) && links.length === 0) {
      // A deleted or unknown file: only one in src/ or test/helpers/ can matter to a test
      if (file.startsWith('src/') || file.startsWith('test/helpers/') || file.startsWith('test/fixtures/')) runAll ??= file;
      continue;
    }
    let hit = false;
    for (const target of [file, ...links]) {
      for (const test of tests) {
        const from = reached.get(test);
        if (!from.has(target)) continue;
        hit = true;
        if (!picked.has(test)) {
          const chain = [];
          for (let at = target; at; at = from.get(at)) chain.push(at);
          if (target !== file) chain.unshift(file);
          picked.set(test, chain.reverse());
        }
      }
    }
    if (!hit && NEEDS_A_TEST.test(file)) unreached.push(file);
  }
  return { runAll, picked, unreached };
}

/**
 * For a runner's --changed: the names (in dir) the changes reach. `commits` is
 * [] (the commits since where HEAD left origin/main, plus uncommitted changes),
 * [A] (the same since A), or [A, B] (only what changed from A to B, with the
 * graph read from B: run at B, the same answer on any machine). Prints what it picked and
 * why, and writes the same to selection.md in outDir.
 */
export function selectForRunner({ dir, names, commits, outDir }) {
  const [from = defaultBase(), to] = commits;
  const changes = changedFiles({ from, to });
  const changed = changes.map(({ file }) => file);
  const uncommitted = new Set(changes.filter((change) => change.uncommitted).map(({ file }) => file));
  const tests = names.map((name) => toPosix(path.relative(ROOT, path.join(dir, name))));
  const { runAll, picked, unreached } = selectTests({ tests, changed, graph: buildGraph({ commit: to }) });
  const pickedNames = runAll ? names : names.filter((name, i) => picked.has(tests[i]));
  const range = to ? `from ${from} to ${to}, the commits only` : `since ${from}, with uncommitted changes`;
  const listed = (file) => `\`${file}\`${uncommitted.has(file) ? ' (uncommitted)' : ''}`;

  const out = [
    `# Tests picked for the changes ${range}`,
    '',
    runAll
      ? `**Everything (${names.length} files):** ${runAll} changed, and it reaches every test.`
      : `**${pickedNames.length} of ${names.length} files.** ${names.length - pickedNames.length} left out: no changed file is in their reach.`,
    '',
    `## Changed files (${changed.length})`,
    ...changed.map((file) => `- ${listed(file)}`),
  ];
  if (!runAll && picked.size > 0) {
    out.push('', '## Picked, each with how it reaches a changed file');
    for (const [test, chain] of picked) out.push(`- \`${test}\`: ${chain.map((file) => `\`${file}\``).join(' → ')}`);
  }
  if (unreached.length > 0) {
    out.push('', '## Changed files no test reaches (source, scripts, fixtures, helpers)', ...unreached.map((file) => `- ${listed(file)}`));
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'selection.md'), `${out.join('\n')}\n`);

  console.log(`--changed: ${changed.length} changed file(s), ${to ? `${from.slice(0, 8)}..${to.slice(0, 8)} (the commits only)` : `since ${from.slice(0, 8)} (with uncommitted changes)`}:`);
  for (const file of changed) console.log(`  ${file}${uncommitted.has(file) ? ' (uncommitted)' : ''}`);
  console.log(runAll
    ? `--changed: everything, because ${runAll} changed`
    : `--changed: ${pickedNames.length} of ${names.length} files reach them`);
  if (unreached.length > 0) console.log(`--changed: no test reaches ${unreached.join(', ')}`);
  console.log(`--changed: why each was picked: ${toPosix(path.relative(ROOT, path.join(outDir, 'selection.md')))}`);
  return pickedNames;
}
