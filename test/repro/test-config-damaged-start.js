// Repro (#692): with a damaged ~/.claude-server-commander/config.json,
// `desktop-commander remote` fails every start with `MCP error -32603`, and
// keeps failing until the user moves the file aside.
//
// Reports: macOS 0.2.50, a truncated file: "Unexpected end of JSON input".
// Windows 0.2.51 (#697 comments), no other instance running:
// "Unexpected token '', ""... is not valid JSON". Node quotes the file's first
// 10 characters there, all invisible: a file of NUL bytes, as a crash
// mid-write leaves it (a BOM would show the `{` after it).
//
// Mechanism: init() cannot parse the file (after retrying it for 1 s), logs it
// and carries on with in-memory defaults; the file stays as it is. Those
// defaults say "new install, welcome page pending", so `initialize` clears the
// flag with setValue, whose mutation reads the same file again and throws: the
// client gets -32603 and `remote` shuts the device down. Every client fails the
// same way, not only `remote`.
//
// Measured on 4715bd4: 10 of 10 starts failed on Windows 11 and 10 of 10 on
// macOS 26, each after ~3.4-3.8 s (the 1 s read wait, twice), for all five
// kinds of damage below; config.json was never changed.
//
// Here each kind of damage is written to config.json in the temporary home,
// and the current build is started the way `remote` starts its local MCP
// (client "desktop-commander-client", DC_REMOTE_DEVICE=true), then asked for
// get_config. After each start the file is compared with what was written.
//
// Run: node test/repro/run-repro.js test-config-damaged-start.js
//      (REPRO_RUNS=2 starts per kind of damage by default)
// Exit code: 1 if any start failed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isTestHome } from '../helpers/test-env.js';
import { startServerLikeRemote } from '../helpers/mcp-server.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const RUNS = Number(process.env.REPRO_RUNS || 2);

// This replaces config.json, so never in a real home
if (!isTestHome()) {
  console.error('Run it through the repro runner: node test/repro/run-repro.js test-config-damaged-start.js');
  exitProcess(2);
}

const configDir = path.join(os.homedir(), '.claude-server-commander');
const configPath = path.join(configDir, 'config.json');

const saved = JSON.stringify({
  blockedCommands: ['rm'],
  allowedDirectories: [os.tmpdir()],
  telemetryEnabled: false,
  pendingWelcomeOnboarding: false,
  welcomeOnboardingEligible: false,
}, null, 2);

const DAMAGE = {
  // The issue's own minimal reproduction
  truncated: Buffer.from('{"defaultShell":'),
  empty: Buffer.alloc(0),
  // A crash mid-write can leave the file's length with no data behind it
  nul: Buffer.alloc(saved.length),
  // An editor saving it as "UTF-8 with BOM" (Notepad, PowerShell 5 Set-Content -Encoding UTF8)
  bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(saved)]),
  // A hand edit adding a Windows folder without doubling its backslashes
  handEdit: Buffer.from(saved.replace(JSON.stringify(os.tmpdir()), '"C:\\Users\\me\\projects"')),
};

async function start() {
  const started = Date.now();
  let server;
  let error = '';
  try {
    server = await startServerLikeRemote(process.env);
    const result = await server.client.callTool({ name: 'get_config', arguments: {} });
    if (result.isError) error = `get_config: ${result.content?.[0]?.text}`;
  } catch (e) {
    error = e?.message ?? String(e);
  } finally {
    await server?.close();
  }
  return { error, ms: Date.now() - started };
}

async function runRepro() {
  let failed = 0;
  let total = 0;
  for (const [kind, bytes] of Object.entries(DAMAGE)) {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, bytes);
    for (let run = 1; run <= RUNS; run++) {
      total++;
      const { error, ms } = await start();
      if (error) failed++;
      const after = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
      const file = after === null ? 'gone' : after.equals(bytes) ? 'unchanged' : `rewritten (${after.length} bytes)`;
      const others = fs.readdirSync(configDir).filter((name) => name !== 'config.json');
      console.log(`${kind} start ${run}: ${error ? `FAILED after ${ms} ms: ${JSON.stringify(error)}` : `ok in ${ms} ms`}; config.json ${file}${others.length ? `; also in the folder: ${others.join(', ')}` : ''}`);
    }
  }

  console.log(failed > 0
    ? `REPRODUCED: ${failed} of ${total} starts with a damaged config.json failed`
    : `NOT REPRODUCED: ${total} starts with a damaged config.json, none failed`);
  exitProcess(failed > 0 ? 1 : 0);
}

// Only in a test home: outside one, the check above refused to run
if (isTestHome()) await runRepro();
