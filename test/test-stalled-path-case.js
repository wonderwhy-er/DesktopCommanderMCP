/**
 * Controlled case-sensitive path regression for the actual lookup queue and
 * validatePath code. Uses POSIX path rules and a case-sensitive resolver on
 * every host; manual timeout callbacks avoid elapsed-time assertions/load.
 * This checks lexical directory/path separation, not mount or pool isolation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { runIfMain } from './helpers/run-if-main.js';

const source = fs.readFileSync(new URL('../src/tools/filesystem.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('filesystem.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['FILE_OPERATION_TIMEOUTS', 'normalizePath', 'comparablePath', 'isInside']);
// Compile production declarations, not a copy of the implementation. Include
// the complete queue block and validatePath, replacing only disk/clock edges.
/** Select the real queue and validation declarations while keeping disk/clock edges controlled. */
const statements = ast.statements.filter((node) => {
  const name = node.name?.text ?? node.declarationList?.declarations[0]?.name?.text;
  return names.has(name) || (node.getStart(ast) >= source.indexOf('export const LOOKUPS_PER_FOLDER')
    && node.getEnd() <= ast.statements.find((item) => item.name?.text === 'validatePath').getEnd());
});
const compiled = ts.transpileModule(statements.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
/** Drain promise continuations without relying on elapsed wall-clock time. */
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Build an isolated case-sensitive resolver with manually released lookups and timeout callbacks. */
function fixture() {
  const timers = new Map();
  const pending = new Map();
  const calls = [];
  const entries = new Set(['/case/Folder/File', '/case/Folder/file', '/case/folder/File',
    '/case/Folder/a', '/case/Folder/b', '/case/folder/a', '/case/folder/healthy',
    ...Array.from({ length: 4 }, (_, i) => `/case/Folder/queued${i}`)]);
  /** Resolve only an exact fixture entry, holding it when the scenario marks it pending. */
  const resolver = async (p) => {
    calls.push(p);
    assert(entries.has(p), `case-sensitive fixture has no exact entry ${p}`);
    if (pending.has(p)) return pending.get(p).promise;
    return p;
  };
  const exports = {};
  const context = vm.createContext({ exports, path: path.posix,
    process: { cwd: () => '/case' }, expandHome: (p) => p,
    resolveRealPath: resolver, resolveEntryPath: resolver,
    isPathAllowed: async () => true, getAllowedDirs: async () => ['/case'],
    fs: { stat: async (p) => assert(entries.has(p)) },
    addToolCallPaths: () => {}, capture: () => {},
    setTimeout: (callback) => { const token = {}; timers.set(token, callback); return token; },
    clearTimeout: (token) => timers.delete(token),
  });
  vm.runInContext(compiled, context, { filename: 'production-lookup-code.js' });
  return {
    calls, validate: exports.validatePath,
    /** Hold one exact path until release() completes its pending lookup. */
    stall(p) {
      let release;
      const promise = new Promise((resolve) => { release = () => resolve(p); });
      pending.set(p, { promise, release });
    },
    /** Fire the current production timeout callbacks without sleeping. */
    async expire() {
      for (const [token, callback] of [...timers]) { timers.delete(token); callback(); }
      await flush();
    },
    /** Finish every held lookup and let production cleanup drain. */
    async release() {
      for (const entry of pending.values()) entry.release();
      await flush();
    },
  };
}

/** Verify a healthy exact-case path reaches its resolver and completes in its own queue turn. */
async function probe(f, p) {
  let result;
  f.validate(p).then((value) => { result = { value }; }, (error) => { result = { error }; });
  await flush();
  assert(result, `healthy ${p} must get its own queue turn`);
  assert(!result.error, `healthy ${p} was rejected: ${result.error?.message}`);
  assert.equal(result.value, p);
  assert(f.calls.includes(p), `healthy ${p} must reach the case-sensitive resolver`);
}

/** Keep a timed-out path separate from healthy case-distinct paths, then verify recovery. */
async function hungPathsKeepCase() {
  const f = fixture();
  f.stall('/case/Folder/File');
  const hung = f.validate('/case/Folder/File').catch((error) => error);
  await flush(); await f.expire();
  assert.match((await hung).message, /isn't responding/);
  try {
    await probe(f, '/case/folder/File');
    await probe(f, '/case/Folder/file');
  } finally { await f.release(); }
  await probe(f, '/case/Folder/File');
}

/** Promote two hung paths to a stalled folder without blocking its case-distinct neighbor. */
async function stalledFoldersKeepCase() {
  const f = fixture();
  for (const p of ['/case/Folder/a', '/case/Folder/b']) f.stall(p);
  const hung = ['/case/Folder/a', '/case/Folder/b'].map((p) => f.validate(p).catch((error) => error));
  await flush(); await f.expire(); await Promise.all(hung);
  try {
    await assert.rejects(f.validate('/case/Folder/file'), /isn't responding/);
    await probe(f, '/case/folder/a');
  } finally { await f.release(); }
}

/** Keep a full folder queue separate from the healthy differently cased directory's queue. */
async function queueFoldersKeepCase() {
  const f = fixture();
  const paths = Array.from({ length: 4 }, (_, i) => `/case/Folder/queued${i}`);
  for (const p of paths) f.stall(p);
  const waiting = paths.map((p) => f.validate(p));
  await flush();
  try { await probe(f, '/case/folder/healthy'); }
  finally { await f.release(); await Promise.all(waiting); }
}

/** Run all controlled case checks and retain each failure instead of stopping after the first. */
export default async function runTests() {
  const failures = [];
  for (const test of [hungPathsKeepCase, stalledFoldersKeepCase, queueFoldersKeepCase]) {
    try { await test(); console.log(`PASS ${test.name}`); }
    catch (error) {
      failures.push(`${test.name}: ${error.message}`);
      console.error(`FAIL ${test.name}: ${error.message}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('PASS 3 controlled POSIX case-sensitive path/queue checks; no elapsed-time or performance claim');
}
runIfMain(import.meta.url, runTests);
