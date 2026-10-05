/**
 * Each search ends with one outcome, and its answers say which (#768): it
 * finished; its time limit, stop_search or maxResults stopped it; some files
 * couldn't be searched; or it failed. One case per answer that changes:
 *  1. time limit, nothing found: "⏱️ Stopped after <ms> ms", and no "Showing results 0--1"
 *  2. stop_search: "⏹️ Stopped on request"
 *  3. maxResults reached: "Stopped at maxResults (<N>)"
 *  4. partly failed (ripgrep ended after matches, an Office file, a folder the
 *     Office search couldn't list): "⚠️ Completed, but some files couldn't be searched"
 *  5. ripgrep ended unexpectedly, nothing found, nothing said: an error
 *  6. ripgrep's exit code 2 that is not about permissions: an error
 *  7. an empty page: "No results at offset <N> (<total> in total)."
 *  8. an empty page while running: "Still running: <N> results so far, none at offset <M> yet."
 *  9. context rows look unlike matches
 * 10. both tools count alike: "<N> matches (<rows> rows with context)"
 * 11. "📖 More results available" only when there are more
 * 12. inputs that aren't whole numbers in range are rejected
 * 13. a finished search's runtime stops; a tail read keeps a session alive
 * 14. start_search answers a search that already failed with the failure
 * Searches that need ripgrep to do something particular (search on until
 * stopped, end unexpectedly, report an error) run in a child process whose
 * ripgrep is a stand-in (fixtures/ripgrep-still-searching-hooks.mjs). The tests
 * change allowedDirectories, so they run only in a test home (the runner's).
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { handleStartSearch, handleGetMoreSearchResults } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { writeFile } from '../dist/tools/filesystem.js';
import { searchUntilDone, startSearchAndWait } from './helpers/search.js';
import { runNode } from './helpers/run-node.js';
import { hookArgs } from './helpers/module-hooks.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const hooksOf = (file) => pathToFileURL(path.join(FIXTURES, file)).href;
const moduleUrl = (file) => JSON.stringify(pathToFileURL(path.join(HERE, file)).href);

const PERMISSIONS_WARNING = '✅ Search completed.\n⚠️  Warning: Some files were inaccessible due to permissions. Results may be incomplete.';

/** An answer's text with its session id and runtime replaced, to compare whole */
const normalized = (text) => text.replace(/search_\d+_\d+/g, '<id>').replace(/^Runtime: \d+m?s$/m, 'Runtime: <t>');
const textOf = (answer) => normalized(answer.content[0].text);

const matchRow = (file, line, text = 'needle') => `📄 ${file}:${line} - ${text}`;
const contextRow = (file, line, text) => `   ${file}:${line} · ${text}`;
const resultRows = (rows) => `Results:\n${rows.join('\n')}\n`;

/** get_more_search_results' answer, as the cases expect it */
function pageAnswer({ status = 'COMPLETED', total, showing, body, end }) {
  return `Search session: <id>\nStatus: ${status}\nRuntime: <t>\nTotal results: ${total}\n` +
    `${showing ? `${showing}\n` : ''}\n${body}${end ? `\n${end}` : ''}`;
}

/** start_search's answer, as the cases expect it */
function startAnswer({ dir, status, total, rows, end }) {
  return `Started content search session: <id>\nPattern: "needle"\nPath: ${dir}\nStatus: ${status}\nRuntime: <t>\n` +
    `Total results: ${total}\n\n${rows.length > 0 ? `Initial results:\n${rows.join('\n')}\n` : ''}\n${end}`;
}

/** A line of ripgrep's --json output: a match of "needle", or a context line */
const rgLine = (type, file, line, text = 'needle') => JSON.stringify({
  type,
  data: {
    path: { text: file },
    lines: { text: `${text}\n` },
    line_number: line,
    absolute_offset: 0,
    submatches: type === 'match' ? [{ match: { text }, start: 0, end: text.length }] : [],
  },
});

/**
 * Runs `body` in a child process with these module hooks and environment, and
 * returns the tool answers it stored in `answers`. The body has the search
 * handlers, searchUntilDone(), and untilComplete(sessionId, args), which reads
 * the session until it is complete or answers with an error.
 */
async function inChild(hooks, env, body) {
  const code = `
    import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from ${moduleUrl('../dist/handlers/search-handlers.js')};
    import { searchManager } from ${moduleUrl('../dist/search-manager.js')};
    import { searchUntilDone } from ${moduleUrl('helpers/search.js')};
    const untilComplete = async (sessionId, args = {}) => {
      for (const deadline = Date.now() + 10000; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
        const page = await handleGetMoreSearchResults({ sessionId, ...args });
        if (page.isError || page.structuredContent.isComplete || Date.now() > deadline) return page;
      }
    };
    const answers = {};
    try {
      ${body}
    } finally {
      searchManager.dispose();
    }
    console.log(JSON.stringify(answers));`;
  const child = await runNode([...hookArgs(hooks), '--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    timeoutMs: 60_000,
  });
  assert.strictEqual(child.status, 0, `the search process failed (${child.status}): ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').pop());
}

/** Runs `body` (see inChild) with a ripgrep that follows `script` (fixtures/ripgrep-scripted.mjs) */
const withScriptedRipgrep = (script, body) =>
  inChild(hooksOf('ripgrep-still-searching-hooks.mjs'), { DC_TEST_RIPGREP_SCRIPT: JSON.stringify(script) }, body);

/**
 * What get_more_search_results answered a search whose ripgrep searches on
 * until its time limit stops it (fixtures/search-stopped-by-time-limit.mjs)
 */
async function timeLimitAnswer(dir, searchArgs) {
  const child = await runNode([
    ...hookArgs(hooksOf('ripgrep-still-searching-hooks.mjs')),
    path.join(FIXTURES, 'search-stopped-by-time-limit.mjs'), dir, ...(searchArgs ? [JSON.stringify(searchArgs)] : []),
  ], { timeoutMs: 60_000 });
  assert.strictEqual(child.status, 0, `the search process failed (${child.status}): ${child.stderr}`);
  const { isError, text, outcome } = JSON.parse(child.stdout.trim().split('\n').pop());
  return { isError, outcome, text: normalized(text) };
}

/** A content search for "needle" in `dir`, run to its end: its last page, or start_search's answer if that was the end */
async function finalAnswer(dir, searchArgs = {}) {
  const { started, page } = await searchUntilDone({ path: dir, pattern: 'needle', searchType: 'content', ...searchArgs });
  return page ?? started;
}

function cases(dir) {
  const at = (...names) => path.join(dir, ...names);
  const search = (more = '') => `{ path: ${JSON.stringify(dir)}, pattern: 'needle', searchType: 'content'${more} }`;

  return [
    ['1. time limit, nothing found: the answer says the time limit stopped it', async () => {
      assert.deepStrictEqual(await timeLimitAnswer(dir), {
        isError: false,
        outcome: 'timed_out',
        text: pageAnswer({ total: '0 matches', body: 'No matches found.', end: '⏱️ Stopped after 1000 ms: results may be incomplete.' }),
      });
    }],
    ['1. the 1.5 s default of an exact-filename file search says so too', async () => {
      assert.deepStrictEqual(await timeLimitAnswer(dir, { pattern: 'report.json', searchType: 'files' }), {
        isError: false,
        outcome: 'timed_out',
        text: pageAnswer({ total: '0 matches', body: 'No matches found.', end: '⏱️ Stopped after 1500 ms: results may be incomplete.' }),
      });
    }],
    ['1, 7. a search that found nothing: no "Showing results 0--1"', async () => {
      assert.strictEqual(textOf(await finalAnswer(at('five'), { pattern: 'zzz-nothing' })),
        pageAnswer({ total: '0 matches', body: 'No matches found.', end: '✅ Search completed.' }));
    }],
    ['2. stop_search: the answer says the search was stopped on request', async () => {
      const files = ['a.txt', 'b.txt', 'c.txt'].map((name) => at(name));
      const { page } = await withScriptedRipgrep({ stdout: files.map((file) => rgLine('match', file, 1)), exit: null }, `
        const { sessionId } = (await handleStartSearch(${search()})).structuredContent;
        await handleStopSearch({ sessionId });
        answers.page = await untilComplete(sessionId);`);
      assert.strictEqual(textOf(page), pageAnswer({
        total: '3 matches',
        showing: 'Showing results 0-2',
        body: resultRows(files.map((file) => matchRow(file, 1))),
        end: '⏹️ Stopped on request: results may be incomplete.',
      }));
    }],
    ['3. maxResults reached: the answer says there may be more', async () => {
      const answer = await finalAnswer(at('max'), { maxResults: 1 });
      const file = /^📄 (.+):1 - needle$/m.exec(answer.content[0].text)?.[1];
      assert(['a.txt', 'b.txt', 'c.txt'].some((name) => file === at('max', name)), `one of the three matches should be shown, got:\n${answer.content[0].text}`);
      assert.strictEqual(textOf(answer), pageAnswer({
        total: '1 match',
        showing: 'Showing results 0-0',
        body: resultRows([matchRow(file, 1)]),
        end: 'Stopped at maxResults (1): there may be more.',
      }));
    }],
    ["4. ripgrep ended unexpectedly after matches: completed, but some files couldn't be searched", async () => {
      const files = [at('a.txt'), at('b.txt')];
      const { page } = await withScriptedRipgrep({ stdout: files.map((file) => rgLine('match', file, 1)), exit: 3, delayMs: 100 }, `
        answers.page = (await searchUntilDone(${search()})).page;`);
      assert.strictEqual(textOf(page), pageAnswer({
        total: '2 matches',
        showing: 'Showing results 0-1',
        body: resultRows(files.map((file) => matchRow(file, 1))),
        end: "⚠️ Completed, but some files couldn't be searched: ripgrep stopped unexpectedly (exit code 3).",
      }));
    }],
    ["4. an Excel file that can't be read: completed, but some files couldn't be searched", async () => {
      const answer = await finalAnswer(at('office'), { filePattern: '*.xlsx' });
      assert.strictEqual(textOf(answer), pageAnswer({
        total: '1 match',
        showing: 'Showing results 0-0',
        body: resultRows([matchRow(`${at('office', 'good.xlsx')}:Sheet1!Row1`, 1)]),
        end: `⚠️ Completed, but some files couldn't be searched: an Excel file couldn't be read (${at('office', 'broken.xlsx')}).`,
      }));
    }],
    ["4. a folder the DOCX search can't list: completed, but some files couldn't be searched", async () => {
      const { page } = await inChild(hooksOf('unlistable-folder-hooks.mjs'), { DC_TEST_UNLISTABLE_CODE: 'EIO' }, `
        answers.page = (await searchUntilDone({ path: ${JSON.stringify(at('walk'))}, pattern: 'needle', searchType: 'content', filePattern: '*.docx' })).page;`);
      assert.strictEqual(textOf(page), pageAnswer({
        total: '1 match',
        showing: 'Showing results 0-0',
        body: resultRows([matchRow(at('walk', 'memo.docx'), 2, 'The needle review is due')]),
        end: `⚠️ Completed, but some files couldn't be searched: a folder couldn't be listed for the DOCX search (${at('walk', 'unlistable')}: EIO).`,
      }));
    }],
    ["4. a folder the DOCX search may not list: the permissions warning, as for ripgrep's", async () => {
      const { page } = await inChild(hooksOf('unlistable-folder-hooks.mjs'), { DC_TEST_UNLISTABLE_CODE: 'EACCES' }, `
        answers.page = (await searchUntilDone({ path: ${JSON.stringify(at('walk'))}, pattern: 'needle', searchType: 'content', filePattern: '*.docx' })).page;`);
      assert.strictEqual(textOf(page), pageAnswer({
        total: '1 match',
        showing: 'Showing results 0-0',
        body: resultRows([matchRow(at('walk', 'memo.docx'), 2, 'The needle review is due')]),
        end: PERMISSIONS_WARNING,
      }));
    }],
    ['5. ripgrep ended unexpectedly, nothing found, nothing said: an error answer', async () => {
      for (const [exit, how] of [[3, 'exit code 3'], ['SIGKILL', 'signal SIGKILL']]) {
        const { answer } = await withScriptedRipgrep({ exit, delayMs: 100 }, `
          const { started, page } = await searchUntilDone(${search()});
          answers.answer = page ?? started;`);
        assert.deepStrictEqual({ isError: !!answer.isError, text: textOf(answer) },
          { isError: true, text: `Search session <id> failed: ripgrep stopped unexpectedly (${how}).` });
      }
    }],
    ["6. exit code 2 for a bad glob while the Office search runs: an error answer with ripgrep's message", async () => {
      const answer = await finalAnswer(at('glob'), { filePattern: '*.docx|{a' });
      const text = answer.content[0].text;
      assert(answer.isError && /^Search session \S+ encountered an error: /.test(text) && text.includes("error parsing glob '{a'"),
        `a search with the invalid glob "{a" should answer with ripgrep's error, even with the DOCX search's match; got:\n${text}`);
    }],
    ["6. exit code 2 that is not about permissions, nothing found: an error answer with ripgrep's message", async () => {
      const error = `rg: ${at('device')}: The device is not ready. (os error 21)`;
      const { answer } = await withScriptedRipgrep({ stderr: `${error}\n`, exit: 2, delayMs: 100 }, `
        const { started, page } = await searchUntilDone({ path: ${JSON.stringify(dir)}, pattern: 'needle', searchType: 'files' });
        answers.answer = page ?? started;`);
      assert.deepStrictEqual({ isError: !!answer.isError, text: textOf(answer) },
        { isError: true, text: `Search session <id> encountered an error: ${error}` });
    }],
    ["6. exit code 2 that is not about permissions, after a match: completed, but some files couldn't be searched", async () => {
      const { page } = await withScriptedRipgrep({
        stdout: [rgLine('match', at('a.txt'), 1)],
        stderr: `rg: ${at('device')}: The device is not ready. (os error 21)\n`,
        exit: 2,
        delayMs: 100,
      }, `answers.page = (await searchUntilDone(${search()})).page;`);
      assert.strictEqual(textOf(page), pageAnswer({
        total: '1 match',
        showing: 'Showing results 0-0',
        body: resultRows([matchRow(at('a.txt'), 1)]),
        end: `⚠️ Completed, but some files couldn't be searched: ripgrep: ${at('device')}: The device is not ready. (os error 21).`,
      }));
    }],
    ['6. exit code 2 for a folder ripgrep may not read: the permissions warning, as before', async () => {
      const denied = process.platform === 'win32' ? 'Access is denied. (os error 5)' : 'Permission denied (os error 13)';
      const { page } = await withScriptedRipgrep({
        stdout: [rgLine('match', at('a.txt'), 1)],
        stderr: `rg: ${at('private')}: ${denied}\n`,
        exit: 2,
        delayMs: 100,
      }, `answers.page = (await searchUntilDone(${search()})).page;`);
      assert.strictEqual(textOf(page), pageAnswer({
        total: '1 match',
        showing: 'Showing results 0-0',
        body: resultRows([matchRow(at('a.txt'), 1)]),
        end: PERMISSIONS_WARNING,
      }));
    }],
    ['7. an empty page past the end: no "Showing results 5-4"', async () => {
      const sessionId = await startSearchAndWait({ path: at('five'), pattern: 'needle', searchType: 'content' });
      assert.strictEqual(textOf(await handleGetMoreSearchResults({ sessionId, offset: 5 })),
        pageAnswer({ total: '5 matches', body: 'No results at offset 5 (5 in total).', end: '✅ Search completed.' }));
    }],
    ['8, 11. pages of a running search: what is there so far, and whether more is coming', async () => {
      const files = ['a', 'b', 'c', 'd', 'e'].map((name) => at(`${name}.txt`));
      const answers = await withScriptedRipgrep({ stdout: files.map((file) => rgLine('match', file, 1)), exit: null }, `
        const { sessionId } = (await handleStartSearch(${search()})).structuredContent;
        answers.empty = await handleGetMoreSearchResults({ sessionId, offset: 10 });
        answers.all = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 5 });
        answers.first = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 2 });`);
      const running = { status: 'IN PROGRESS', total: '5 matches' };
      assert.strictEqual(textOf(answers.empty),
        pageAnswer({ ...running, body: 'Still running: 5 results so far, none at offset 10 yet.' }), 'case 8');
      assert.strictEqual(textOf(answers.all), pageAnswer({
        ...running,
        showing: 'Showing results 0-4',
        body: resultRows(files.map((file) => matchRow(file, 1))),
        end: 'Still running: more may come.',
      }), 'case 11: all there is so far');
      assert.strictEqual(textOf(answers.first), pageAnswer({
        ...running,
        showing: 'Showing results 0-1',
        body: resultRows(files.slice(0, 2).map((file) => matchRow(file, 1))),
        end: '📖 More results available. Use get_more_search_results with offset: 2',
      }), 'case 11: more are there');
    }],
    ['9, 10. get_more_search_results: context rows unlike matches, matches counted with their rows', async () => {
      const file = at('context', 'context.txt');
      assert.strictEqual(textOf(await finalAnswer(at('context'), { contextLines: 1 })), pageAnswer({
        total: '1 match (3 rows with context)',
        showing: 'Showing results 0-2',
        body: resultRows([contextRow(file, 1, 'before'), matchRow(file, 2), contextRow(file, 3, 'after')]),
        end: '✅ Search completed.',
      }));
    }],
    ['9, 10. start_search: context rows unlike matches, matches counted with their rows', async () => {
      const file = at('context', 'context.txt');
      const { started } = await withScriptedRipgrep({
        stdout: [rgLine('context', file, 1, 'before'), rgLine('match', file, 2), rgLine('context', file, 3, 'after')],
        exit: 0,
      }, `answers.started = await handleStartSearch(${search()});`);
      assert.strictEqual(textOf(started), startAnswer({
        dir,
        status: 'COMPLETED',
        total: '1 match (3 rows with context)',
        rows: [contextRow(file, 1, 'before'), matchRow(file, 2), contextRow(file, 3, 'after')],
        end: '✅ Search completed.',
      }));
    }],
    ["12. inputs that aren't whole numbers in range are rejected, with what is expected", async () => {
      const sessionId = await startSearchAndWait({ path: at('five'), pattern: 'needle', searchType: 'content' });
      const start = (args) => handleStartSearch({ path: at('five'), pattern: 'needle', searchType: 'content', ...args });
      const rejected = [
        ['get_more_search_results', { length: -1 }, 'length must be a whole number of at least 1'],
        ['get_more_search_results', { length: 0 }, 'length must be a whole number of at least 1'],
        ['get_more_search_results', { length: 1.5 }, 'length must be a whole number of at least 1'],
        ['get_more_search_results', { offset: 0.5 }, 'offset must be a whole number'],
        ['start_search', { maxResults: 1.5 }, 'maxResults must be a whole number of at least 0'],
        ['start_search', { maxResults: -1 }, 'maxResults must be a whole number of at least 0'],
        ['start_search', { contextLines: 1.5 }, 'contextLines must be a whole number of at least 0'],
        ['start_search', { contextLines: -1 }, 'contextLines must be a whole number of at least 0'],
        ['start_search', { timeout_ms: -5 }, 'timeout_ms must be a whole number of at least 0'],
        ['start_search', { timeout_ms: 1.5 }, 'timeout_ms must be a whole number of at least 0'],
      ];
      for (const [tool, args, message] of rejected) {
        const answer = tool === 'start_search' ? await start(args) : await handleGetMoreSearchResults({ sessionId, ...args });
        const text = answer.content[0].text;
        assert(answer.isError && text.startsWith(`Invalid arguments for ${tool}: `) && text.includes(message),
          `${tool} with ${JSON.stringify(args)} should be rejected with "${message}", got:\n${text}`);
      }
      for (const [tool, args] of [
        ['get_more_search_results', { length: 1 }], ['get_more_search_results', { offset: -1 }],
        ['start_search', { maxResults: 0 }], ['start_search', { contextLines: 0 }], ['start_search', { timeout_ms: 0 }],
      ]) {
        const answer = tool === 'start_search' ? await start(args) : await handleGetMoreSearchResults({ sessionId, ...args });
        assert(!answer.isError, `${tool} with ${JSON.stringify(args)} should be accepted, got:\n${answer.content[0].text}`);
      }
    }],
    ["13. a finished search's runtime stops at its end", async () => {
      const sessionId = await startSearchAndWait({ path: at('five'), pattern: 'needle', searchType: 'content' });
      const runtimes = () => [
        searchManager.readSearchResults(sessionId).runtime,
        searchManager.listSearchSessions().find((session) => session.id === sessionId).runtime,
      ];
      const atEnd = runtimes();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepStrictEqual(runtimes(), atEnd, 'get_more_search_results and list_searches should report the runtime the search had when it ended');
    }],
    ['13. a tail read (negative offset) keeps a finished session, as other reads do', async () => {
      const sessionId = await startSearchAndWait({ path: at('five'), pattern: 'needle', searchType: 'content' });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert(!(await handleGetMoreSearchResults({ sessionId, offset: -1 })).isError, 'the tail read should answer');
      // Sessions not read for 500 ms go: this one was read just now
      searchManager.cleanupSessions(500);
      const page = await handleGetMoreSearchResults({ sessionId, offset: 0 });
      assert(!page.isError, `a session just read from its end should still be there, got: ${page.content[0].text}`);
    }],
    ['14. start_search answers a search that failed before it answered with the failure', async () => {
      const regexError = 'rg: regex parse error:\n    (unclosed\n    ^\nerror: unclosed group\n';
      const { failed } = await withScriptedRipgrep({ stderr: regexError, exit: 2 }, `
        answers.failed = await handleStartSearch(${search()});`);
      assert(failed.isError && textOf(failed).startsWith('Search session <id> encountered an error: rg: regex parse error:'),
        `start_search should answer with ripgrep's error, got:\n${failed.content[0].text}`);
      assert(failed.structuredContent?.sessionId, "the failed session should still be named for the server's own code");

      const { ended } = await withScriptedRipgrep({ exit: 3 }, `answers.ended = await handleStartSearch(${search()});`);
      assert.deepStrictEqual({ isError: !!ended.isError, text: textOf(ended) },
        { isError: true, text: 'Search session <id> failed: ripgrep stopped unexpectedly (exit code 3).' });
    }],
  ];
}

/** The folders and files the cases search, in `dir` */
async function writeFiles(dir) {
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  for (const name of ['a.txt', 'b.txt', 'c.txt']) write(path.join('max', name), 'needle\n');
  write(path.join('five', 'five.txt'), [1, 2, 3, 4, 5].map((n) => `needle ${n}`).join('\n') + '\n');
  write(path.join('context', 'context.txt'), 'before\nneedle\nafter\n');
  // Office files, written by Desktop Commander's own Excel and DOCX handlers
  for (const folder of ['office', 'walk', 'glob']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  await writeFile(path.join(dir, 'office', 'good.xlsx'), JSON.stringify([['needle']]));
  write(path.join('office', 'broken.xlsx'), 'this is not a workbook\n');
  await writeFile(path.join(dir, 'walk', 'memo.docx'), 'Memo title\nThe needle review is due');
  fs.mkdirSync(path.join(dir, 'walk', 'unlistable'));
  await writeFile(path.join(dir, 'glob', 'memo.docx'), 'Memo title\nThe needle review is due');
}

export default async function runTests() {
  if (!isTestHome()) {
    return skip('test-search-outcome.js changes allowedDirectories: it runs only in a test home (node test/run-all-tests.js test-search-outcome.js)');
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-outcome-')));
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);
  const failures = [];
  try {
    await writeFiles(dir);
    for (const [label, run] of cases(dir)) {
      try {
        await run();
        console.log(`✓ ${label}`);
      } catch (error) {
        failures.push(label);
        console.log(`✗ ${label}\n  ${error.message.split('\n').join('\n  ')}`);
      }
    }
  } finally {
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} search outcome case(s) failed`);
    return false;
  }
  console.log('✅ Each search answers with its one outcome');
  return true;
}

runIfMain(import.meta.url, runTests);
