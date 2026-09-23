/**
 * Runs the repro scripts in this folder, each in its own process with an
 * isolated temporary home (so none can touch the real Desktop Commander
 * config), and reports each script's exit code.
 *
 * Usage:
 *   node test/repro/run-repro.js                              # every script
 *   node test/repro/run-repro.js test-dc-tracking-gate.js ... # selected scripts
 * Variables such as UV_THREADPOOL_SIZE, BLOCKERS or DC_REPRO_REALTIME are passed through.
 * A script still running after REPRO_TIMEOUT_MS (default 180000) is stopped and fails.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTestEnv } from '../helpers/test-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_TIME_LIMIT_MS = Number(process.env.REPRO_TIMEOUT_MS) || 180_000;

function runScript(file) {
  return new Promise((resolve) => {
    console.log(`\n===== ${file} =====`);
    const testEnv = createTestEnv();
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: __dirname,
      env: testEnv.env,
      stdio: 'inherit',
    });
    let timedOut = false;
    const limit = setTimeout(() => {
      timedOut = true;
      console.error(`\n${file} still running after ${SCRIPT_TIME_LIMIT_MS}ms: stopping it`);
      child.kill();
    }, SCRIPT_TIME_LIMIT_MS);
    const finish = (code) => {
      clearTimeout(limit);
      testEnv.cleanup();
      resolve({ file, code: timedOut ? 'timeout' : code, ms: Date.now() - started });
    };
    child.on('close', finish);
    child.on('error', (error) => {
      console.error(`Failed to start ${file}: ${error.message}`);
      finish(1);
    });
  });
}

const requested = process.argv.slice(2);
const files = requested.length > 0
  ? requested
  : (await fs.readdir(__dirname)).filter((file) => file.startsWith('test-') && file.endsWith('.js')).sort();

const results = [];
for (const file of files) results.push(await runScript(file));

console.log('\n===== REPRO SUMMARY =====');
for (const { file, code, ms } of results) {
  console.log(`${code === 0 ? '✓' : '✗'} ${file} (exit ${code}, ${ms}ms)`);
}
process.exit(results.every((result) => result.code === 0) ? 0 : 1);
