/**
 * Guard (#716): what the search tools answer must not change while the server
 * stops keeping whole lines. Very long and short match and context lines are
 * searched through the real server (dist/index.js over stdio); the answers of
 * start_search and get_more_search_results must be exactly what the layer
 * below #716 gives: each entry the first 100 characters of its text (the
 * matched text for a match, the trimmed line for context), then '...' when it
 * goes on; the same entries, counts and order, also when the search is cut at
 * maxResults. A match whose text is not valid UTF-8 (ripgrep sends it as
 * bytes) is still listed. Passes on that layer and with the #716 fixes.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { connectToServer, readSearchAnswer, closeClient } from './helpers/mcp-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const MB = 1024 * 1024;
const PATTERN = 'needle\\w*';
const PATTERN_RE = /needle\w*/i;
/** start_search's default contextLines (schemas.ts) */
const CONTEXT_LINES = 5;
const ENTRY = '📄 ';

/** The fixture, line by line: every kind of entry, long and short */
const LINES = [
  'short context line',                    // 1  context
  'needle',                                // 2  match, short
  `    ${'var a=1;'.repeat(MB / 8)}   `,   // 3  context of 1 MB, spaces around it
  `needle ${'z=1;'.repeat(MB / 4)}`,       // 4  match: short text on a 1 MB line
  'c'.repeat(100),                         // 5  context of exactly 100 characters
  'd'.repeat(101),                         // 6  context of 101
  `needle${'x'.repeat(MB)}`,               // 7  match: the matched text is 1 MB
  `  ${'e'.repeat(99)}  `,                 // 8  context, 99 characters once trimmed
  `needle${'q'.repeat(94)}`,               // 9  match of exactly 100 characters
  `needle${'r'.repeat(95)}`,               // 10 match of 101
  'f1', 'f2', 'f3', 'f4', 'f5',            // 11-15 context after line 10
  'gap 1', 'gap 2', 'gap 3', 'gap 4',      // 16-19 in no match's context
  'g1', 'g2', 'g3', 'g4', `${'w '.repeat(MB / 2)}`, // 20-24 context before line 25
  `${'y'.repeat(MB)} needle`,              // 25 match at the end of a 1 MB line
  'tail context',                          // 26 context
];

/**
 * The entries ripgrep reports with CONTEXT_LINES of context, in order: each
 * match with its matched text, each context line trimmed
 */
function allEntries() {
  const isMatch = LINES.map((line) => PATTERN_RE.test(line));
  const entries = [];
  LINES.forEach((line, i) => {
    if (isMatch[i]) {
      entries.push({ line: i + 1, text: PATTERN_RE.exec(line)[0], match: true });
    } else if (isMatch.some((match, j) => match && Math.abs(i - j) <= CONTEXT_LINES)) {
      entries.push({ line: i + 1, text: line.trim(), match: false });
    }
  });
  return entries;
}

/**
 * A search cut at maxResults: everything up to the last match it keeps, then
 * that match's trailing context (a match in it shown as it is), nothing after
 */
function entriesUpTo(maxResults) {
  const kept = [];
  let matches = 0;
  let trailingEnd = 0;
  for (const entry of allEntries()) {
    if (matches < maxResults) {
      kept.push(entry);
      if (entry.match) {
        matches++;
        trailingEnd = entry.line + CONTEXT_LINES;
      }
    } else if (entry.line <= trailingEnd) {
      kept.push(entry);
    } else {
      break;
    }
  }
  return kept;
}

/** An entry as the answers show it (search-handlers.ts) */
const shown = (file, { line, text }) =>
  `${ENTRY}${file}:${line} - ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`;

/**
 * get_more_search_results' answer for a completed search, first page. cutAt:
 * the search stopped at maxResults (a match in the trailing context after it
 * counts as context).
 */
function expectedAnswer(sessionId, file, entries, cutAt) {
  const matches = cutAt ?? entries.filter((entry) => entry.match).length;
  let text = `Search session: ${sessionId}\n`;
  text += 'Status: COMPLETED\n';
  text += 'Runtime: <n>s\n';
  text += `Total results found: ${entries.length} (${matches} matches)\n`;
  text += `Showing results 0-${entries.length - 1}\n\n`;
  text += 'Results:\n';
  for (const entry of entries) text += `${shown(file, entry)}\n`;
  text += '\n✅ Search completed.';
  return text;
}

const answerText = (result) => result.content?.[0]?.text ?? '';
const withoutRuntime = (text) => text.replace(/^Runtime: \d+s$/m, 'Runtime: <n>s');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs one search to completion; returns start_search's and get_more_search_results' answers */
async function search(client, dir, maxResults, pattern = PATTERN) {
  const started = await client.callTool({
    name: 'start_search',
    arguments: { path: dir, pattern, searchType: 'content', maxResults },
  });
  const { sessionId } = readSearchAnswer(started);
  assert(sessionId, `start_search failed: ${answerText(started)}`);
  const deadline = Date.now() + 60_000;
  let page;
  do {
    await sleep(100);
    page = await client.callTool({ name: 'get_more_search_results', arguments: { sessionId, offset: 0, length: 1 } });
  } while (!readSearchAnswer(page).isComplete && Date.now() < deadline);
  assert(readSearchAnswer(page).isComplete, `the search did not complete within 60 s: ${answerText(page)}`);
  const answer = await client.callTool({ name: 'get_more_search_results', arguments: { sessionId } });
  await client.callTool({ name: 'stop_search', arguments: { sessionId } });
  return { sessionId, start: answerText(started), answer: answerText(answer) };
}

/**
 * Checks both answers of one search against the base's: start_search shows
 * whichever results have arrived (up to 10), in order; get_more_search_results
 * the whole of them.
 */
function checkAnswers(label, { sessionId, start, answer }, entries, cutAt) {
  const firstEntry = answer.split('\n').find((line) => line.startsWith(ENTRY));
  const firstSuffix = `:${entries[0].line} - ${entries[0].text}`;
  assert(firstEntry?.endsWith(firstSuffix), `${label}: the first entry should end with "${firstSuffix}", got: ${firstEntry}`);
  const file = firstEntry.slice(ENTRY.length, -firstSuffix.length);
  assert(file.endsWith('guard.js'), `${label}: the entries should name guard.js, got: ${file}`);

  assert.strictEqual(withoutRuntime(answer), expectedAnswer(sessionId, file, entries, cutAt),
    `${label}: get_more_search_results answered differently from the base`);

  const startEntries = start.split('\n').filter((line) => line.startsWith(ENTRY));
  assert.deepStrictEqual(startEntries, entries.slice(0, startEntries.length).map((entry) => shown(file, entry)),
    `${label}: start_search's initial results differ from the base's`);
}

const NON_UTF8_CASE = 'a match whose text is not valid UTF-8 is listed';

/**
 * ripgrep sends a line, and matched text, that is not valid UTF-8 as base64
 * "bytes" instead of "text". Such a match was listed (its text unreadable); it
 * must stay listed, not be dropped.
 */
async function checkNonUtf8Match(client, dir) {
  const nonUtf8Dir = path.join(dir, 'non-utf8');
  fs.mkdirSync(nonUtf8Dir);
  // "café needle" in Latin-1: é is the single byte E9
  fs.writeFileSync(path.join(nonUtf8Dir, 'latin1.txt'), Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' needle\n')]));
  // The match includes the E9 byte, so its text is not valid UTF-8 either
  const { answer } = await search(client, nonUtf8Dir, 200, 'caf(?-u:\\xE9) needle');
  const { totalResults, totalMatches } = readSearchAnswer({ content: [{ text: answer }] });
  assert.deepStrictEqual({ totalResults, totalMatches }, { totalResults: 1, totalMatches: 1 },
    `the match should be counted, got:\n${answer}`);
  const entry = answer.split('\n').find((line) => line.startsWith(ENTRY));
  assert(entry?.includes('latin1.txt:1 - '), `the match should be listed, got:\n${answer}`);
}

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-answers-')));
  fs.writeFileSync(path.join(dir, 'guard.js'), `${LINES.join('\n')}\n`);

  const cases = [
    // 6 matches: nothing is cut
    { name: 'every entry, long and short (maxResults: 200)', maxResults: 200, entries: allEntries() },
    { name: 'a search cut at maxResults: 2, matches in the trailing context', maxResults: 2, entries: entriesUpTo(2), cutAt: 2 },
  ];
  const failures = [];
  let client;
  try {
    client = await connectToServer('search-answers-guard');
    for (const { name, maxResults, entries, cutAt } of cases) {
      try {
        checkAnswers(name, await search(client, dir, maxResults), entries, cutAt);
        console.log(`✓ ${name}`);
      } catch (error) {
        failures.push(name);
        console.log(`✗ ${name}\n  ${error.message}`);
      }
    }
    try {
      await checkNonUtf8Match(client, dir);
      console.log(`✓ ${NON_UTF8_CASE}`);
    } catch (error) {
      failures.push(NON_UTF8_CASE);
      console.log(`✗ ${NON_UTF8_CASE}\n  ${error.message}`);
    }
  } finally {
    await closeClient(client);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} of ${cases.length + 1} answer guards failed`);
    return false;
  }
  console.log('✅ Search answers are unchanged');
  return true;
}

runIfMain(import.meta.url, runTests);
