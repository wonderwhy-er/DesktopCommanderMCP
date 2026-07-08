/**
 * Test: onboarding_injection flag must be authoritative on cold starts
 *
 * Reproduces GitHub issues #303 / #538: the onboarding [SYSTEM INSTRUCTION]
 * is injected into tool results even though the remote feature flag serves
 * onboarding_injection: false. On a cold start (no feature-flags.json cache,
 * e.g. an ephemeral Docker MCP Gateway container) the first tool call races
 * the background flag fetch, the in-memory flag map is still empty, and the
 * check falls through to its fail-open default.
 *
 * Strategy: spawn dist/index.js as a real MCP client would (stdio transport)
 * with HOME pointed at a pristine temp directory, controlling flag delivery
 * via DC_FLAG_URL and a local HTTP server. Four scenarios:
 *
 *   1. Cold start, flag server unreachable            -> must NOT inject (any call)
 *   2. Cold start, flags(false) served slower than
 *      the first tool call (the race in the issues)   -> must NOT inject (any call)
 *   3. Cold start, flags(true) served slowly          -> MUST inject once flags load
 *      (guards that the fail-closed default doesn't kill the feature: the
 *      first call sees empty flags, but a later call must show onboarding)
 *   4. Warm cache with flags(false), no network       -> must NOT inject
 */

import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.js');
const MARKER = 'NEW USER ONBOARDING REQUIRED';
const SCENARIO_TIMEOUT_MS = 20000;

/**
 * Create a pristine "container" home dir. Config is seeded with telemetry
 * disabled (so tests emit no analytics) but deliberately has no
 * onboardingState and no feature-flags.json cache, matching a fresh
 * ephemeral container. Pass cachedFlags to simulate a warm cache instead.
 */
function makeHome({ cachedFlags } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-onboarding-test-'));
  const cfgDir = path.join(home, '.claude-server-commander');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ telemetryEnabled: false }));
  if (cachedFlags) {
    writeFileSync(
      path.join(cfgDir, 'feature-flags.json'),
      JSON.stringify({ version: 'cached-test', flags: cachedFlags })
    );
  }
  return home;
}

/** Serve feature flags after an optional delay (to lose the startup race on purpose) */
function startFlagServer(flags, delayMs = 0) {
  const server = createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: 'live-test', flags }));
    }, delayMs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Spawn the MCP server with the given home/flag URL, perform the initialize
 * handshake as "docker-mcp-gateway" (the client from issue #538), and call a
 * tool immediately. When followUpDelayMs is set, a second tool call is made
 * after that delay — long enough for the background flag fetch to complete —
 * so scenarios can assert behavior both before and after flags load.
 * Returns the collected tool result texts.
 */
function callToolOnFreshServer({ home, flagUrl, followUpDelayMs = null }) {
  return new Promise((resolve) => {
    const child = spawn('node', [DIST_INDEX], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home, // Windows homedir
        DC_FLAG_URL: flagUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let settled = false;
    const texts = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      child.kill('SIGTERM');
      resolve(result);
    };

    const timeoutHandle = setTimeout(
      () => finish({ error: 'timeout waiting for tool result' }),
      SCENARIO_TIMEOUT_MS
    );

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    const toolCall = (id) =>
      send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'get_config', arguments: {} },
      });

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx);
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // stray non-protocol output
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          // Fire the first tool call immediately — on a cold start this is
          // what races (and beats) the background flag fetch.
          toolCall(2);
        } else if (msg.id === 2 || msg.id === 3) {
          texts.push(
            (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n')
          );
          if (msg.id === 2 && followUpDelayMs !== null) {
            setTimeout(() => toolCall(3), followUpDelayMs);
          } else {
            finish({ texts });
          }
        }
      }
    });

    child.on('error', (err) => finish({ error: err.message }));
    child.on('exit', (code) => {
      if (!settled) finish({ error: `server exited early with code ${code}` });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'docker-mcp-gateway', version: '1.0.0' },
      },
    });
  });
}

async function runScenario({ name, expectInjection, home, flagUrl, followUpDelayMs }) {
  const result = await callToolOnFreshServer({ home, flagUrl, followUpDelayMs });
  rmSync(home, { recursive: true, force: true });

  if (result.error) {
    console.error(`  ✗ ${name}: ERROR - ${result.error}`);
    return false;
  }

  const injected = result.texts.some((t) => t.includes(MARKER));
  const pass = injected === expectInjection;
  const status = pass ? '✓' : '✗';
  const detail = injected
    ? 'onboarding [SYSTEM INSTRUCTION] injected'
    : 'no injection';
  console.log(
    `  ${status} ${name}: ${detail} (expected: ${expectInjection ? 'injected' : 'no injection'})`
  );
  return pass;
}

async function main() {
  console.log('Testing onboarding_injection flag authority on cold starts (#303/#538)\n');

  // Delay flag responses past the first tool call so the test deterministically
  // reproduces the startup race from the issues. Must stay well under the flag
  // manager's 3s fetch timeout, and under the follow-up call delay so second
  // calls observe loaded flags.
  const RACE_DELAY_MS = 1000;
  const FOLLOW_UP_DELAY_MS = 2000;

  const flagsFalseServer = await startFlagServer({ onboarding_injection: false }, RACE_DELAY_MS);
  const flagsTrueServer = await startFlagServer({ onboarding_injection: true }, RACE_DELAY_MS);
  const unreachableUrl = 'http://127.0.0.1:9/'; // discard port: connection refused

  const results = [];
  try {
    results.push(
      await runScenario({
        name: 'cold start, flag server unreachable (two calls)',
        expectInjection: false,
        home: makeHome(),
        flagUrl: unreachableUrl,
        followUpDelayMs: FOLLOW_UP_DELAY_MS,
      })
    );

    results.push(
      await runScenario({
        name: 'cold start, flags(false) arrive after first tool call (two calls)',
        expectInjection: false,
        home: makeHome(),
        flagUrl: `http://127.0.0.1:${flagsFalseServer.address().port}/`,
        followUpDelayMs: FOLLOW_UP_DELAY_MS,
      })
    );

    results.push(
      await runScenario({
        name: 'cold start, flags(true): onboarding fires once flags load',
        expectInjection: true,
        home: makeHome(),
        flagUrl: `http://127.0.0.1:${flagsTrueServer.address().port}/`,
        followUpDelayMs: FOLLOW_UP_DELAY_MS,
      })
    );

    results.push(
      await runScenario({
        name: 'warm cache with flags(false), no network',
        expectInjection: false,
        home: makeHome({ cachedFlags: { onboarding_injection: false } }),
        flagUrl: unreachableUrl,
      })
    );
  } finally {
    flagsFalseServer.close();
    flagsTrueServer.close();
  }

  const failed = results.filter((r) => !r).length;
  if (failed > 0) {
    console.error(`\n${failed}/${results.length} scenarios failed — onboarding_injection flag is not authoritative (issue #538).`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} scenarios passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
