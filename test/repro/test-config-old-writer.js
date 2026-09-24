// Repro (#697): `desktop-commander remote` beside an older Desktop Commander
// fails to start with `-32603 Unexpected end of JSON input`, and floods its
// log with "Failed to reload config".
//
// Desktop Commander 0.2.48 and older write config.json in place: the file is
// empty from the moment the writer opens it until the content lands. Measured
// with the real 0.2.46 serving tool calls beside the current build: empty for
// p50 27 ms, p99 150 ms, max 261 ms per write on Windows (p50 15 ms, max 63 ms
// on macOS). A reader that gives up on an empty file within that window fails.
//
// Here a stand-in for the old version rewrites config.json in place over and
// over, leaving it empty for EMPTY_MS each time, while the current build is
// started the way `remote` starts its local MCP (client "desktop-commander-client")
// and kept up for a moment. Every log line and every failed start is counted.
//
// Run: node test/repro/run-repro.js test-config-old-writer.js
//      (REPRO_RUNS=5 starts by default)
// Exit code: 1 if any start failed or logged "Failed to reload config".
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { isTestHome } from '../helpers/test-env.js';
import { closeClient } from '../helpers/close-client.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(PROJECT_ROOT, 'dist/index.js');
const RUNS = Number(process.env.REPRO_RUNS || 5);
/** How long the old version leaves config.json empty per write: about the measured p99 on Windows */
const EMPTY_MS = 150;
/** Pause between the old version's writes (it writes on every tool call) */
const BETWEEN_WRITES_MS = 100;
/** Keep each started server up this long, so its config watcher sees several writes */
const STAY_UP_MS = 2000;

// This rewrites config.json, so never in a real home
if (!isTestHome()) {
  console.error('Run it through the repro runner: node test/repro/run-repro.js test-config-old-writer.js');
  exitProcess(2);
}

async function runRepro() {
  const configPath = path.join(os.homedir(), '.claude-server-commander', 'config.json');
  const config = JSON.stringify({
    telemetryEnabled: false,
    pendingWelcomeOnboarding: false,
    welcomeOnboardingEligible: false,
    writtenBy: 'older-version',
  }, null, 2);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The old version: open with truncate (the file is now empty), write it all a moment later
  let writing = true;
  const oldVersion = (async () => {
    while (writing) {
      fs.writeFileSync(configPath, '');
      await sleep(EMPTY_MS);
      fs.writeFileSync(configPath, config);
      await sleep(BETWEEN_WRITES_MS);
    }
  })();

  let failedStarts = 0;
  let reloadErrors = 0;
  for (let run = 1; run <= RUNS; run++) {
    let log = '';
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env }, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk) => { log += chunk; });
    const client = new Client({ name: 'desktop-commander-client', version: '1.0.0' }, { capabilities: {} });
    // The server's console.error reaches the client as log notifications
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { log += `${JSON.stringify(notification.params)}\n`; });
    let error = '';
    try {
      await client.connect(transport, { timeout: 30_000 });
      await sleep(STAY_UP_MS);
    } catch (e) {
      error = e?.message ?? String(e);
      failedStarts++;
    } finally {
      await closeClient(client);
    }
    const reloads = (log.match(/Failed to reload config/g) ?? []).length;
    reloadErrors += reloads;
    console.log(`start ${run}: ${error ? `FAILED ${error}` : 'ok'}${reloads ? `, ${reloads} "Failed to reload config"` : ''}`);
  }

  writing = false;
  await oldVersion;

  const reproduced = failedStarts > 0 || reloadErrors > 0;
  console.log(reproduced
    ? `REPRODUCED: ${failedStarts} of ${RUNS} starts failed, ${reloadErrors} "Failed to reload config" while an older version wrote config.json in place`
    : `NOT REPRODUCED: ${RUNS} starts, no failure and no reload error while an older version wrote config.json in place`);
  exitProcess(reproduced ? 1 : 0);
}

// Only in a test home: outside one, the check above refused to run
if (isTestHome()) await runRepro();
