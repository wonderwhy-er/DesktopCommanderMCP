/**
 * A process whose config lock is taken over while it holds it must not die.
 *
 * proper-lockfile refreshes the lock every 10 s. If the process couldn't run
 * for over 30 s while inside a config write (machine sleep, a suspended
 * process, a blocked event loop), another Desktop Commander process that
 * writes config.json meanwhile finds the lock stale and takes it over. When
 * the first one runs again, its refresh finds the lock no longer its own, and
 * proper-lockfile's default reaction throws from a timer: an uncaught
 * exception, and the server exits (index.ts). The write in progress would
 * still have committed atomically.
 *
 * Here a child process (its own config manager) is inside a write, holding
 * the lock, when the lock directory is replaced by another process's; the
 * write waits until the lock's refresh has run. Expected: one log line about
 * the lost lock, the write lands, the process finishes normally.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createTestEnv } from './helpers/test-env.js';
import { runConfigManagerChild } from './helpers/config-child.js';
import { runIfMain } from './helpers/run-if-main.js';

async function run() {
  const { env, home, cleanup } = createTestEnv();
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }, null, 2));
  try {
    const child = runConfigManagerChild(env, {
      prelude: `
        const { CONFIG_FILE } = await import(DIST + '/config.js');
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        let lockLost = false;
        const logError = console.error;
        console.error = (...args) => {
          if (/config lock was lost/i.test(String(args[0]))) lockLost = true;
          logError(...args);
        };
        // The new config.json's write (inside the lock) waits: meanwhile another process
        // takes the lock over (its directory replaced by that process's), and the write
        // goes on once this process has seen it (at the lock's 10 s refresh), or after 30 s
        const { open } = fs;
        let tookOver = false;
        fs.open = async (file, flags, ...rest) => {
          if (!tookOver && String(file).startsWith(CONFIG_FILE + '.') && String(file).endsWith('.tmp')) {
            tookOver = true;
            fsSync.rmSync(CONFIG_FILE + '.lock', { recursive: true, force: true });
            fsSync.mkdirSync(CONFIG_FILE + '.lock');
            // Its lock, with its own time (not this process's, even at a whole-second precision)
            const theirs = new Date(Date.now() - 60000);
            fsSync.utimesSync(CONFIG_FILE + '.lock', theirs, theirs);
            const deadline = Date.now() + 30000;
            while (!lockLost && Date.now() < deadline) await sleep(100);
          }
          return open(file, flags, ...rest);
        };`,
      body: `
        await configManager.setValue('heldChange', 42);
        console.log(JSON.stringify({ written: true }));`,
    });
    assert(!/ECOMPROMISED/.test(child.stderr) || child.status === 0,
      `a process whose config lock was taken over while it held it died (exit ${child.status}): ${child.stderr.slice(0, 600)}`);
    assert.strictEqual(child.status, 0, `the process failed (exit ${child.status}): ${child.stderr.slice(0, 600)}`);
    assert(child.result?.written, `the config write did not finish: ${child.stdout}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).heldChange, 42, 'the write in progress must still land');
    const lost = child.stderr.split('\n').filter((line) => /config lock was lost/i.test(line));
    assert.strictEqual(lost.length, 1, `the lost lock should be logged once, in one line; stderr: ${child.stderr.slice(0, 600)}`);
    assert(lost[0].includes('ECOMPROMISED') || lost[0].includes('Unable to update lock'), `the log line should give the error: ${lost[0]}`);
    console.log('✓ a process whose config lock is taken over while it holds it logs it once and finishes its write');
    return true;
  } catch (error) {
    console.log(`✗ a process whose config lock is taken over while it holds it logs it once and finishes its write\n  ${error.message}`);
    return false;
  } finally {
    cleanup();
  }
}

runIfMain(import.meta.url, run);

export default run;
