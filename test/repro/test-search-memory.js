// Repro (#716): a content search with maxResults: 200 on a large project took
// the process tree from about 5 GB to over 70 GB in two minutes, ripgrep alone
// about 14 GB, and left the Mac unresponsive. maxResults bounds the number of
// matches a search keeps, not the memory behind them:
// - many:     in a folder search ripgrep holds a file's whole output until the
//             file is done. Nothing bounds that output per file (-m went when
//             maxResults became a total), so the server can only stop ripgrep
//             once all of it is written.
// - context:  --json ignores --max-columns, so each match and context line
//             arrives whole, and the session keeps each context line whole
//             (contextLines defaults to 5) though an answer shows 100
//             characters of it.
// - line:     the server appends each chunk to the pending line and splits all
//             of it again, so one long line costs time quadratic in its length.
// - v8-limit: past V8's string limit (2^29 - 24 characters in Node 24) that
//             append throws and the server exits. Opt-in (REPRO_V8_LIMIT=1): on
//             the base it takes 13 minutes of the server's CPU to get there.
// - near-cap: opt-in (REPRO_SCENARIOS=near-cap), no finding unless the server
//             exits: a line 1 MB under the longest the server assembles (half
//             of V8's longest string) is processed whole; shows what that costs.
// Measured on the base (4715bd4), default sizes, over 4 runs each on Windows 11
// and macOS 26.6 (sampled peaks vary):
//   many:     ripgrep peak 264-520 MB / 248-322 MB for 200 results
//   context:  server +384-411 MB / +406-437 MB for 160 matches (250 MB of context text)
//   line:     7.5-7.7 s, server +656-664 MB / 2.5-3.8 s, +732-1,448 MB
//   v8-limit: the server exits ("Uncaught exception: Invalid string length")
//             after 778 s, server peak 3,654 MB, ripgrep 2,318 MB (Windows)
// With the #716 fixes, near-cap (a 255 MB line): server peak ~1.05 GB on both.
// On Windows the time of "many" is mostly the antivirus scanning the new 64 MB
// file when ripgrep first opens it. ripgrep's own memory on very long lines is
// not bounded here: its JSON output can't cut a line, and each thread holds its
// file's lines until the file is done.
//
// Each scenario generates its fixture in a temporary folder, starts
// dist/index.js with the SDK client, runs start_search (content, "needle",
// maxResults: 200, the default contextLines) until it completes, and samples
// the peak memory of the server and of its ripgrep (test/helpers/process-memory.js).
//
// Run: node test/repro/run-repro.js test-search-memory.js
//      (REPRO_MB scales the fixtures, default 64; REPRO_SCENARIOS=many,line picks some;
//       REPRO_V8_LIMIT=1 adds the 540 MB line: set REPRO_TIMEOUT_MS=2400000 and
//       REPRO_SEARCH_LIMIT_MS=2200000 for the base; REPRO_SAMPLE_MS sets the
//       sampling interval, default 100)
// Exit code: 1 if the problem shows: ripgrep holds more than 128 MB for 200
// results, the server grows by more than all the context text, a 48 MB line
// takes more than 5 s or grows the server by more than 8 times its size, or the
// server exits. 2 (NOT MEASURED) if a scenario judged by memory has no valid
// measurement: its memory could not be sampled, or (many, context) its search
// failed or did not complete. A many search whose ripgrep exited between two
// samples (sampling worked but never saw it) is named as not measured, as a
// skipped check is: it isn't counted as bounded and doesn't fail the run.
import { constants } from 'buffer';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { watchPeakMemory, formatMB } from '../helpers/process-memory.js';
import { readSearchAnswer, closeClient } from '../helpers/mcp-client.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(PROJECT_ROOT, 'dist/index.js');
const MB = 1024 * 1024;
const SCALE = Number(process.env.REPRO_MB || 64) / 64;
const MAX_RESULTS = 200;
/** An answer shows this much of each entry (search-handlers.ts) */
const SHOWN_CHARS = 100;
/** A search still running after this long is stopped and reported */
const SEARCH_LIMIT_MS = Number(process.env.REPRO_SEARCH_LIMIT_MS || 170_000);
/** How often the server and its ripgrep are sampled */
const SAMPLE_MS = Number(process.env.REPRO_SAMPLE_MS || 100);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes `size` bytes made of `unit` repeated (and cut to size) */
function writeRepeated(fd, unit, size) {
  const block = Buffer.from(unit.repeat(Math.ceil(Math.min(size, MB) / unit.length))).subarray(0, Math.min(size, MB));
  let left = size;
  while (left > 0) {
    const n = Math.min(left, block.length);
    fs.writeSync(fd, block, 0, n);
    left -= n;
  }
}

const SCENARIOS = {
  many: {
    size: Math.round(64 * SCALE) * MB,
    describe() { return `one ${formatMB(this.size)} file of matching lines`; },
    make(dir) {
      const fd = fs.openSync(path.join(dir, 'matches.js'), 'w');
      writeRepeated(fd, 'const needle = "an ordinary line of code that matches the search";\n', this.size);
      fs.closeSync(fd);
    },
  },
  context: {
    // Many files, so ripgrep, which holds one file's output per thread, stays small
    files: Math.max(1, Math.round(160 * SCALE)),
    lineSize: 160 * 1024,
    describe() { return `${this.files} files, each one match between 10 lines of ${this.lineSize / 1024} KB`; },
    /** Context text the session can keep: every line around the matches */
    contextBytes() { return this.files * 10 * this.lineSize; },
    make(dir) {
      for (let i = 0; i < this.files; i++) {
        const fd = fs.openSync(path.join(dir, `bundle-${i}.min.js`), 'w');
        for (let c = 0; c < 11; c++) {
          if (c === 5) {
            fs.writeSync(fd, `needle ${i}\n`);
          } else {
            writeRepeated(fd, 'var a=1;', this.lineSize);
            fs.writeSync(fd, '\n');
          }
        }
        fs.closeSync(fd);
      }
    },
  },
  line: {
    size: Math.round(48 * SCALE) * MB,
    describe() { return `one matching line of ${formatMB(this.size)}`; },
    make(dir) {
      const fd = fs.openSync(path.join(dir, 'data.json'), 'w');
      fs.writeSync(fd, '{"needle":"');
      writeRepeated(fd, 'x', this.size);
      fs.writeSync(fd, '"}\n');
      fs.closeSync(fd);
    },
  },
  'v8-limit': {
    size: 540 * MB,
    describe() { return `one matching line of ${formatMB(this.size)}, past V8's string limit`; },
    make(dir) { SCENARIOS.line.make.call(this, dir); },
  },
  'near-cap': {
    // 1 MB under the longest line the server assembles (half of V8's longest string), JSON included
    size: Math.floor(constants.MAX_STRING_LENGTH / 2) - MB,
    describe() { return `one matching line of ${formatMB(this.size)}, just under the longest the server assembles`; },
    make(dir) { SCENARIOS.line.make.call(this, dir); },
  },
};

const text = (result) => result.content?.[0]?.text ?? '';

async function runScenario(name) {
  const scenario = SCENARIOS[name];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dc-search-memory-${name}-`));
  const outcome = { name, fixture: scenario.describe() };
  try {
    scenario.make(dir);

    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env }, stderr: 'pipe' });
    let serverLog = '';
    transport.stderr?.setEncoding('utf8');
    transport.stderr?.on('data', (chunk) => { serverLog += chunk; });
    const client = new Client({ name: 'repro-search-memory', version: '1.0.0' }, { capabilities: {} });
    // The server's console.error reaches the client as log notifications
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { serverLog += `${JSON.stringify(notification.params)}\n`; });
    let serverExited = false;
    transport.onclose = () => { serverExited = true; };
    await client.connect(transport, { timeout: 30_000 });

    const serverPid = transport.pid;
    const memory = watchPeakMemory(serverPid, SAMPLE_MS);
    let started = Date.now();
    try {
      await sleep(1000);
      // Growth is measured from the server's first sample (PowerShell can take seconds to start)
      const sampledBy = Date.now() + 20_000;
      while (!memory.peakOf(serverPid) && !memory.failure() && Date.now() < sampledBy) await sleep(100);
      outcome.serverBefore = memory.peakOf(serverPid);

      started = Date.now();
      const start = await client.callTool({
        name: 'start_search',
        arguments: { path: dir, pattern: 'needle', searchType: 'content', maxResults: MAX_RESULTS },
      }, undefined, { timeout: SEARCH_LIMIT_MS });
      const { sessionId } = readSearchAnswer(start);
      if (!sessionId) throw new Error(`start_search failed: ${text(start)}`);

      let page;
      while (Date.now() - started < SEARCH_LIMIT_MS) {
        page = await client.callTool({ name: 'get_more_search_results', arguments: { sessionId, offset: 0, length: 1 } },
          undefined, { timeout: SEARCH_LIMIT_MS });
        if (readSearchAnswer(page).isComplete) break;
        await sleep(250);
      }
      outcome.seconds = (Date.now() - started) / 1000;
      outcome.complete = !!page && readSearchAnswer(page).isComplete;
      if (!outcome.complete) {
        await client.callTool({ name: 'stop_search', arguments: { sessionId } })
          .catch((error) => console.log(`(stop_search failed: ${error?.message ?? error})`));
      }
      const answer = await client.callTool({ name: 'get_more_search_results', arguments: { sessionId, offset: 0, length: 3000 } });
      ({ totalMatches: outcome.matches, totalResults: outcome.results } = readSearchAnswer(answer));
      outcome.answerChars = text(answer).length;
      await sleep(500);
    } catch (error) {
      outcome.seconds ??= (Date.now() - started) / 1000;
      outcome.error = error?.message ?? String(error);
      await sleep(500);
    } finally {
      memory.stop();
      outcome.serverPeak = memory.peakOf(serverPid);
      outcome.ripgrepPeak = memory.peakOfName('rg');
      outcome.samplingFailure = memory.failure() ?? (outcome.serverBefore ? undefined : 'the server was not sampled before the search');
      outcome.serverExited = serverExited;
      if (serverExited) outcome.serverLog = [...new Set(serverLog.split('\n').filter((l) => /exception|error/i.test(l)))].slice(-3).join(' | ');
      await closeClient(client);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return outcome;
}

const names = (process.env.REPRO_SCENARIOS?.split(',') ?? ['many', 'context', 'line'])
  .concat(process.env.REPRO_V8_LIMIT === '1' ? ['v8-limit'] : []);
const findings = [];
/** Scenarios that give no valid measurement to judge by */
const unmeasured = [];
/** Scenarios sampling worked for but never saw ripgrep in (it exited between samples) */
const notSampled = [];
for (const name of names) {
  const o = await runScenario(name);
  const growth = o.serverPeak - o.serverBefore;
  console.log(`${name}: ${o.fixture}; maxResults ${MAX_RESULTS}, answer shows ${SHOWN_CHARS} characters per entry`);
  console.log(`  ${o.complete ? 'completed' : 'NOT completed'} in ${o.seconds?.toFixed(1)} s: ${o.matches} matches, ${o.results} results, answer ${o.answerChars} characters`);
  const ripgrepMemory = o.ripgrepPeak ? formatMB(o.ripgrepPeak) : o.samplingFailure ? 'not measured' : 'not measured: ripgrep exited between samples';
  console.log(`  ripgrep peak ${ripgrepMemory}; server peak ${formatMB(o.serverPeak)} (${formatMB(o.serverBefore)} before the search, + ${formatMB(growth)})`);
  if (o.samplingFailure) console.log(`  memory not measured: ${o.samplingFailure}`);
  if (o.error) console.log(`  error: ${o.error}`);
  if (o.serverExited) console.log(`  the server exited${o.serverLog ? `: ${o.serverLog}` : ''}`);

  if (o.serverExited) findings.push(`${name}: the server exited during the search`);
  // Memory is judged only from valid samples
  const sampled = !o.samplingFailure;
  // many and context measure a search that completes (line counts one that doesn't as a finding)
  const searched = !((name === 'many' || name === 'context') && (o.error || !o.complete));
  if (name === 'many' && sampled && searched && o.ripgrepPeak > 128 * MB) {
    findings.push(`many: ripgrep held ${formatMB(o.ripgrepPeak)} for a ${MAX_RESULTS}-result search`);
  }
  if (name === 'context' && sampled && searched && growth > SCENARIOS.context.contextBytes()) {
    findings.push(`context: the server grew ${formatMB(growth)}, more than all the context text (${formatMB(SCENARIOS.context.contextBytes())}), for ${o.matches} matches whose answer shows ${SHOWN_CHARS} characters per entry`);
  }
  const lineFinding = name === 'line' && (!o.complete || o.seconds > 5 || (sampled && growth > 8 * SCENARIOS.line.size));
  if (lineFinding) {
    findings.push(`line: a search through one ${formatMB(SCENARIOS.line.size)} line took ${o.seconds.toFixed(1)} s and grew the server ${formatMB(growth)}`);
  }
  // many, context and line are judged by memory too (v8-limit and near-cap only by the server exiting)
  if ((name === 'many' || name === 'context' || (name === 'line' && !lineFinding)) && !o.serverExited && o.samplingFailure) {
    unmeasured.push(`${name}: memory not measured (${o.samplingFailure})`);
  }
  // many is judged by ripgrep's peak. A ripgrep that started and exited between
  // two samples was never seen, so its peak reads 0, which measures nothing
  if (name === 'many' && sampled && searched && !o.serverExited && !o.ripgrepPeak) notSampled.push(name);
  if (!searched && !o.serverExited) {
    unmeasured.push(`${name}: the search ${o.error ? `failed (${o.error})` : `did not complete within ${SEARCH_LIMIT_MS / 1000} s`}`);
  }
}

// A scenario whose ripgrep exited between samples is named, as a skipped check
// is, and never counted as bounded
const skippedNote = notSampled.length > 0
  ? `not measured: ${notSampled.map((name) => `${name} (ripgrep exited between samples)`).join(', ')}` : '';
const withSkipped = (line) => (skippedNote ? `${line}; ${skippedNote}` : line);
const bounded = names.filter((name) => !notSampled.includes(name));
if (unmeasured.length > 0) console.log(withSkipped(`NOT MEASURED: ${unmeasured.join('; ')}`));
if (findings.length > 0) {
  const line = `REPRODUCED: ${findings.join('; ')}`;
  console.log(unmeasured.length > 0 ? line : withSkipped(line));
} else if (unmeasured.length === 0) {
  console.log(bounded.length > 0
    ? withSkipped(`NOT REPRODUCED: a ${MAX_RESULTS}-result search stayed bounded in ripgrep and the server (${bounded.join(', ')})`)
    : `SKIPPED: ${skippedNote}`);
}
// A request to a server that exited can leave its timeout timer running
exitProcess(findings.length > 0 ? 1 : unmeasured.length > 0 ? 2 : 0);
