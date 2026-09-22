// #702: report what a process did, not what its output text looks like.
// The worker runs with HOME/USERPROFILE in a temp directory, so the real
// ~/.claude-server-commander/config.json is never read or written.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
// Generous: a busy machine must not turn a reporting assertion into a timing one.
const PROCESS_TIMEOUT_MS = 15_000;
const WORKER_TIMEOUT_MS = 180_000;

const silentExit = (code) => `node -e "process.exit(${code})"`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Naming the shell keeps executeCommand from reading config at all. */
const shellForTests = () => (process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/sh'));

/** Flushed before the worker leaves, or the parent never sees it. */
const report = (message) => new Promise((resolve) => {
  if (!process.send) return resolve();
  process.send(message, () => resolve());
});

const replyText = (result) => result?.content?.[0]?.text ?? '';

async function describeStart(startProcess, command) {
  return replyText(await startProcess({ command, timeout_ms: PROCESS_TIMEOUT_MS }));
}

/**
 * Retries until the event lands inside the close grace, and fails saying so if
 * it never does — asserting on a run that missed the window proves nothing.
 */
async function withGraceWindow(label, attempt, attempts = 4) {
  const missed = [];
  for (let i = 1; i <= attempts; i++) {
    const outcome = await attempt(i);
    if (outcome.constructed) return outcome;
    missed.push(outcome.text.slice(0, 160));
  }
  throw new Error(
    `${label}: the event never landed inside the grace window in ${attempts} attempts, so this case proved nothing. Replies seen: ${JSON.stringify(missed)}`
  );
}

function pidOf(text) {
  const match = text.match(/Process started with PID (\d+)/);
  assert.ok(match, `expected a PID in: ${JSON.stringify(text)}`);
  return Number(match[1]);
}

async function worker() {
  const { startProcess, readProcessOutput, forceTerminate } =
    await import('../dist/tools/improved-process-tools.js');
  const { terminalManager } = await import('../dist/terminal-manager.js');
  const helpers = process.env.DC_702_HELPER_DIR;

  try {
    // 1. The #702 shape: dead on arrival, nothing on stdout or stderr.
    const failed = await describeStart(startProcess, silentExit(255));
    assert.ok(
      /exit code 255/i.test(failed),
      `start_process must report the exit code of a process that already finished, got: ${JSON.stringify(failed)}`
    );
    assert.ok(
      !/is running/i.test(failed),
      `a finished process must not be described as running, got: ${JSON.stringify(failed)}`
    );
    assert.ok(
      failed.includes('❌'),
      `a non-zero exit must not be marked as success, got: ${JSON.stringify(failed)}`
    );
    console.log('✓ a silent non-zero exit is reported with its exit code and a failure marker');

    // 2. Guards a fix that only reports failures: empty output is not trouble.
    const quiet = await describeStart(startProcess, silentExit(0));
    assert.ok(
      /exit code 0/i.test(quiet) && quiet.includes('✅'),
      `a silent successful exit must be reported as finished with code 0, got: ${JSON.stringify(quiet)}`
    );
    console.log('✓ a silent successful exit is reported as finished');

    // 3. The widest surface: every quick command gains a line, and its own
    // output must survive beside it, exactly once.
    const loud = await describeStart(startProcess, 'node -e "console.log(\'hello from the child\')"');
    assert.ok(
      loud.includes('hello from the child'),
      `the command output must survive, got: ${JSON.stringify(loud)}`
    );
    assert.equal(
      (loud.match(/Process completed/g) ?? []).length, 1,
      `exactly one completion line is expected, got: ${JSON.stringify(loud)}`
    );
    console.log('✓ an ordinary command keeps its output and gains one completion line');

    // 4. Completion must not be claimed while a grandchild still holds the pipe.
    const inFlight = await describeStart(startProcess, `node ${path.join(helpers, 'late-writer.cjs')}`);
    // Without this anchor, a helper that never started passes the negation below.
    assert.ok(
      inFlight.includes('child up, pipe handed over'),
      `the helper must have run and printed before exiting, got: ${JSON.stringify(inFlight)}`
    );
    // Only the grace path says this, so it proves the pipe was really held.
    assert.ok(
      /output pipe is still open/.test(inFlight),
      `the grandchild must have held the pipe open, got: ${JSON.stringify(inFlight)}`
    );
    assert.ok(
      !/Process completed/i.test(inFlight),
      `completion must not be claimed while another process still holds the output pipe, got: ${JSON.stringify(inFlight)}`
    );
    console.log('✓ completion is not claimed while output is still in flight');

    // 5. A signalled process has no exit code, and "exit code null" under a
    // failure marker turns a deliberate stop into a crash.
    const alive = await describeStart(startProcess, `node ${path.join(helpers, 'stays-alive.cjs')}`);
    const pid = pidOf(alive);
    await forceTerminate({ pid });

    let afterKill = '';
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      afterKill = replyText(await readProcessOutput({ pid, timeout_ms: 1_000 }));
      if (/terminated|exit code/i.test(afterKill)) break;
    }
    assert.ok(
      !/exit code null/i.test(afterKill),
      `a signalled process must not be reported as "exit code null", got: ${JSON.stringify(afterKill)}`
    );
    assert.ok(
      /terminated by SIG/i.test(afterKill),
      `a signalled process must be reported as terminated by its signal, got: ${JSON.stringify(afterKill)}`
    );
    console.log('✓ a process killed by a signal is reported as terminated, not as "exit code null"');

    // 6. getNewOutput is the third caller of that sentence, and the one
    // interact_with_process reads.
    const legacy = await terminalManager.executeCommand(silentExit(3), PROCESS_TIMEOUT_MS, shellForTests());
    const legacyText = terminalManager.getNewOutput(legacy.pid) ?? '';
    assert.ok(
      /❌ Process completed with exit code 3 \(runtime: \d+\.\d\ds\)/.test(legacyText),
      `getNewOutput must use the shared completion sentence, got: ${JSON.stringify(legacyText)}`
    );
    assert.ok(
      legacyText.includes('(No output produced)'),
      `getNewOutput must still say when there was no output, got: ${JSON.stringify(legacyText)}`
    );
    console.log('✓ getNewOutput reports completion in the same shared wording');

    // 7. The wait timeout must not answer for a process that already exited.
    // The trigger puts it inside the grace; the marker says whether it landed.
    const afterTimeout = await withGraceWindow('the wait timeout', async (attempt) => {
      const trigger = path.join(helpers, `trigger-a-${attempt}`);
      const marker = path.join(helpers, `exited-a-${attempt}`);
      const pending = startProcess({
        command: `node ${path.join(helpers, 'exit-on-trigger.cjs')} ${trigger} ${marker}`,
        timeout_ms: 2_100
      });
      setTimeout(() => writeFileSync(trigger, ''), 1_950);
      const text = replyText(await pending);
      // Written just before exit: present means the answer was about a dead one.
      return { constructed: existsSync(marker), text };
    });
    assert.ok(
      afterTimeout.text.includes('child up'),
      `the helper must have run, got: ${JSON.stringify(afterTimeout.text)}`
    );
    assert.ok(
      !/Process is running/i.test(afterTimeout.text),
      `a process that already exited must not be reported as running, got: ${JSON.stringify(afterTimeout.text)}`
    );
    assert.ok(
      /code 7/.test(afterTimeout.text),
      `the exit code is known at that moment and must be reported, got: ${JSON.stringify(afterTimeout.text)}`
    );
    console.log('✓ an exited process is reported by its code, not as still running');

    // 8. Output arriving between 'exit' and the answer must not vanish from
    // every later read of the same pid.
    const withLate = await withGraceWindow('the post-exit write', async (attempt) => {
      const trigger = path.join(helpers, `trigger-b-${attempt}`);
      const pending = startProcess({
        command: `node ${path.join(helpers, 'late-on-trigger.cjs')} ${trigger}`,
        timeout_ms: PROCESS_TIMEOUT_MS
      });
      setTimeout(() => writeFileSync(trigger, ''), 60);
      const text = replyText(await pending);
      return { constructed: text.includes('arrived after exit'), text };
    });
    const reread = replyText(await readProcessOutput({ pid: pidOf(withLate.text), timeout_ms: 1_000 }));
    assert.ok(
      reread.includes('arrived after exit'),
      `a later read must not show less than start_process already showed, got: ${JSON.stringify(reread)}`
    );
    console.log('✓ a later read shows everything start_process already showed');

    // 9. The prompt check must not answer either. 'bash-' is a prompt the fast
    // path does not match, so only that interval could produce this reply.
    const promptTail = await describeStart(startProcess, `node ${path.join(helpers, 'prompt-then-exit.cjs')}`);
    assert.ok(
      promptTail.includes('bash-'),
      `the helper must have printed its prompt-like tail, got: ${JSON.stringify(promptTail)}`
    );
    // Without this, a grandchild that failed to start leaves an ordinary
    // completion line and passes the negation below while proving nothing.
    assert.ok(
      /output pipe is still open/.test(promptTail),
      `the grandchild must have held the pipe open, got: ${JSON.stringify(promptTail)}`
    );
    assert.ok(
      !/waiting for input/i.test(promptTail),
      `a process that already exited cannot be waiting for input, got: ${JSON.stringify(promptTail)}`
    );
    console.log('✓ the prompt check does not report an exited process as waiting for input');

    // 10. read_process_output must not confirm the completion start_process
    // refused milliseconds earlier.
    const readWhileOpen = replyText(await readProcessOutput({ pid: pidOf(promptTail), timeout_ms: 1_000 }));
    assert.ok(
      readWhileOpen.includes('bash-'),
      `the read must have found the session, got: ${JSON.stringify(readWhileOpen)}`
    );
    assert.ok(
      !/Process completed/i.test(readWhileOpen),
      `read_process_output must not claim completion while the output pipe is still open, got: ${JSON.stringify(readWhileOpen)}`
    );
    assert.ok(
      /output pipe is still open/.test(readWhileOpen),
      `read_process_output must say the pipe is still open, got: ${JSON.stringify(readWhileOpen)}`
    );
    console.log('✓ read_process_output agrees with start_process while the pipe is open');

    // 11. Past 2MB only the tail is kept, and under a completion line that
    // reads as the whole story.
    const flooded = await describeStart(startProcess, `node ${path.join(helpers, 'flood.cjs')}`);
    const floodTail = flooded.slice(-400);
    assert.ok(
      /truncated/i.test(flooded),
      `a truncated initial output must say so, tail was: ${JSON.stringify(floodTail)}`
    );
    assert.ok(
      /read_process_output/.test(flooded),
      `a truncated initial output must point at the full output, tail was: ${JSON.stringify(floodTail)}`
    );
    console.log('✓ a truncated initial output says so and points at the rest');

    // 12. start_process("ssh -V") runs "ssh -t -V". Holds with or without ssh
    // installed: the rewrite happens before the spawn.
    const rewritten = await describeStart(startProcess, 'ssh -V');
    assert.ok(
      /Process started with PID/.test(rewritten),
      `the command must have been run, got: ${JSON.stringify(rewritten)}`
    );
    assert.ok(
      /ssh -t -V/.test(rewritten),
      `the reply must disclose the command that actually ran, got: ${JSON.stringify(rewritten)}`
    );
    console.log('✓ a rewritten command is disclosed in the reply');

    // 13. A failed spawn returns before the promise that carries the rewrite,
    // which is when knowing what was about to run matters most.
    const bogusShell = process.platform === 'win32'
      ? '/usr/bin/definitely-not-a-shell'
      : '/definitely/not/a/shell';
    const failedSpawn = replyText(await startProcess({
      command: 'ssh -V',
      shell: bogusShell,
      timeout_ms: 3_000
    }));
    assert.ok(
      /failed to get process id/i.test(failedSpawn),
      `this case needs a spawn that fails, got: ${JSON.stringify(failedSpawn)}`
    );
    assert.ok(
      /ssh -t -V/.test(failedSpawn),
      `a failed spawn must still disclose the command it was about to run, got: ${JSON.stringify(failedSpawn)}`
    );
    console.log('✓ a failed spawn still discloses the rewritten command');

    // 14. "Read again for the rest" has to have a rest: the record must not be
    // a copy frozen when the answer was built.
    const triggerAfterAnswer = path.join(helpers, 'trigger-after-answer');
    const openPipe = await describeStart(
      startProcess,
      `node ${path.join(helpers, 'late-holder.cjs')} ${triggerAfterAnswer}`
    );
    assert.ok(
      /output pipe is still open/.test(openPipe),
      `this case needs the answer that comes while the pipe is held, got: ${JSON.stringify(openPipe)}`
    );
    assert.ok(
      !openPipe.includes('arrived after exit'),
      `the grandchild must not have written yet, got: ${JSON.stringify(openPipe)}`
    );

    writeFileSync(triggerAfterAnswer, '');
    let afterAnswer = '';
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      afterAnswer = replyText(await readProcessOutput({ pid: pidOf(openPipe), timeout_ms: 1_000 }));
      if (afterAnswer.includes('arrived after exit')) break;
    }
    assert.ok(
      afterAnswer.includes('arrived after exit'),
      `output written after the answer must become readable, got: ${JSON.stringify(afterAnswer)}`
    );
    console.log('✓ output arriving after the answer is readable afterwards');

    // 15. Eviction after the answer must be reported too: the counters must not
    // stay frozen while the buffer is live.
    const triggerFlood = path.join(helpers, 'trigger-flood');
    const beforeFlood = await describeStart(
      startProcess,
      `node ${path.join(helpers, 'flood-holder.cjs')} ${triggerFlood}`
    );
    assert.ok(
      /output pipe is still open/.test(beforeFlood),
      `this case needs the answer that comes while the pipe is held, got: ${JSON.stringify(beforeFlood)}`
    );

    writeFileSync(triggerFlood, '');
    let afterFlood = '';
    // Inside the holder's lifetime: the point is eviction reported while the
    // pipe is open, not once 'close' refreshes it.
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      afterFlood = replyText(await readProcessOutput({ pid: pidOf(beforeFlood), timeout_ms: 1_000 }));
      if (/evicted/i.test(afterFlood)) break;
    }
    assert.ok(
      /output pipe is still open/.test(afterFlood),
      `the holder must still be holding the pipe, got: ${JSON.stringify(afterFlood.slice(-300))}`
    );
    assert.ok(
      /evicted/i.test(afterFlood),
      `lines evicted after the reply must still be reported as evicted, got: ${JSON.stringify(afterFlood.slice(-300))}`
    );
    console.log('✓ eviction after the answer is still reported');

    // 16. The guard trims before it matches and the replace does not, so a
    // command with a leading space runs untouched while the reply names it as
    // rewritten — the tool telling an untruth about itself.
    const notRewritten = await describeStart(startProcess, '  ssh -V');
    assert.ok(
      /Process started with PID/.test(notRewritten),
      `the command must have run, got: ${JSON.stringify(notRewritten)}`
    );
    assert.ok(
      !/Command rewritten/.test(notRewritten),
      `a command that was not rewritten must not be reported as one, got: ${JSON.stringify(notRewritten)}`
    );
    console.log('✓ a command the rewrite left alone is not reported as rewritten');

    // 17. The last path that still decided completion from the output text:
    // analyzeProcessState reads "Error:" as a finished process, so a child that
    // prints one and keeps running was announced as finished — the defect this
    // whole file is about, on the one branch the earlier fixes left standing.
    const stillRunning = replyText(await startProcess({
      command: `node ${path.join(helpers, 'error-then-run.cjs')}`,
      timeout_ms: 1_500
    }));
    assert.ok(
      stillRunning.includes('Error: still working'),
      `the helper must have printed before the wait ended, got: ${JSON.stringify(stillRunning)}`
    );
    assert.ok(
      !/has finished execution/.test(stillRunning),
      `a process that is still running must not be reported as finished, got: ${JSON.stringify(stillRunning)}`
    );
    assert.ok(
      /Process is running/.test(stillRunning),
      `a process that is still running must be reported as running, got: ${JSON.stringify(stillRunning)}`
    );
    console.log('✓ a running process is not called finished because of its output text');

    await report({ type: 'done' });
  } catch (error) {
    // The assertion message is the point; the parent fails once, with that text.
    await report({ type: 'failed', message: error?.message ?? String(error) });
    process.exit(1);
  }
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-702-exit-code-'));
  // The helpers run through a shell, where a path with spaces quotes differently.
  assert.ok(!/\s/.test(home), `temp path must not contain spaces, got: ${home}`);

  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    telemetryEnabled: false,
    welcomeOnboardingEligible: false,
    pendingWelcomeOnboarding: false
  }));

  // Holds the inherited pipe open without writing, so 'close' stays away.
  writeFileSync(path.join(home, 'hold-pipe.cjs'), 'setTimeout(() => {}, 10000);\n');

  // Writes on the trigger and keeps holding: the line must be readable without
  // 'close'.
  writeFileSync(path.join(home, 'print-and-hold.cjs'), [
    "const fs = require('fs');",
    'const trigger = process.argv[2];',
    'const wait = setInterval(() => {',
    '  if (fs.existsSync(trigger)) {',
    '    clearInterval(wait);',
    "    console.log('arrived after exit');",
    '  }',
    '}, 20);',
    'setTimeout(() => process.exit(0), 10000);'
  ].join('\n'));

  writeFileSync(path.join(home, 'late-holder.cjs'), [
    "const { spawn } = require('child_process');",
    'const trigger = process.argv[2];',
    "const kid = spawn(process.execPath, [__dirname + '/print-and-hold.cjs', trigger], { stdio: ['ignore', 1, 2], detached: true });",
    'kid.unref();',
    "console.log('child up');",
    'process.exit(0);'
  ].join('\n'));

  writeFileSync(path.join(home, 'print-on-trigger.cjs'), [
    "const fs = require('fs');",
    'const trigger = process.argv[2];',
    'const wait = setInterval(() => {',
    '  if (fs.existsSync(trigger)) {',
    '    clearInterval(wait);',
    "    console.log('arrived after exit');",
    '    process.exit(0);',
    '  }',
    '}, 20);',
    'setTimeout(() => process.exit(0), 10000);'
  ].join('\n'));

  // Hands the pipe to a grandchild that prints later; its own marker proves it ran.
  writeFileSync(path.join(home, 'late-writer.cjs'), [
    "const { spawn } = require('child_process');",
    "const late = [ '-e', 'setTimeout(() => console.log(\"late output\"), 1500)' ];",
    "const kid = spawn(process.execPath, late, { stdio: ['ignore', 1, 2], detached: true });",
    'kid.unref();',
    "console.log('child up, pipe handed over');",
    'process.exit(0);'
  ].join('\n'));

  // Exits when the test says so, pipe held, and records that it did.
  writeFileSync(path.join(home, 'exit-on-trigger.cjs'), [
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    'const trigger = process.argv[2];',
    'const marker = process.argv[3];',
    "const kid = spawn(process.execPath, [__dirname + '/hold-pipe.cjs'], { stdio: ['ignore', 1, 2], detached: true });",
    'kid.unref();',
    "console.log('child up');",
    'const wait = setInterval(() => {',
    '  if (fs.existsSync(trigger)) {',
    '    clearInterval(wait);',
    "    fs.writeFileSync(marker, '');",
    '    process.exit(7);',
    '  }',
    '}, 10);',
    'setTimeout(() => process.exit(0), 10000);'
  ].join('\n'));

  // Leaves a prompt-shaped tail and exits, pipe held, so 'close' cannot answer.
  writeFileSync(path.join(home, 'prompt-then-exit.cjs'), [
    "const { spawn } = require('child_process');",
    "const kid = spawn(process.execPath, [__dirname + '/hold-pipe.cjs'], { stdio: ['ignore', 1, 2], detached: true });",
    'kid.unref();',
    "process.stdout.write('bash-', () => process.exit(0));"
  ].join('\n'));

  // Its grandchild writes after the exit but before the answer.
  writeFileSync(path.join(home, 'late-on-trigger.cjs'), [
    "const { spawn } = require('child_process');",
    'const trigger = process.argv[2];',
    "const kid = spawn(process.execPath, [__dirname + '/print-on-trigger.cjs', trigger], { stdio: ['ignore', 1, 2], detached: true });",
    'kid.unref();',
    "console.log('child up');",
    'process.exit(0);'
  ].join('\n'));

  // Prints a line analyzeProcessState reads as completion, then keeps running.
  writeFileSync(path.join(home, 'error-then-run.cjs'), [
    "console.log('Error: still working');",
    'setTimeout(() => {}, 20000);'
  ].join('\n'));

  // Exits on its own if it is not killed, so a failing run leaves nothing behind.
  writeFileSync(path.join(home, 'stays-alive.cjs'), 'setTimeout(() => {}, 20000);\n');

  // Floods past the 50MB cap after the reply, then keeps holding the pipe.
  writeFileSync(path.join(home, 'flood-on-trigger.cjs'), [
    "const fs = require('fs');",
    'const trigger = process.argv[2];',
    "const line = 'x'.repeat(999);",
    'const wait = setInterval(() => {',
    '  if (!fs.existsSync(trigger)) return;',
    '  clearInterval(wait);',
    '  for (let i = 0; i < 60000; i++) console.log(line);',
    '}, 20);',
    'setTimeout(() => process.exit(0), 60000);'
  ].join('\n'));

  writeFileSync(path.join(home, 'flood-holder.cjs'), [
    "const { spawn } = require('child_process');",
    'const trigger = process.argv[2];',
    "const kid = spawn(process.execPath, [__dirname + '/flood-on-trigger.cjs', trigger], { stdio: ['ignore', 1, 2], detached: true });",
    'kid.unref();',
    "console.log('child up');",
    'process.exit(0);'
  ].join('\n'));

  // ~3MB, past the 2MB wait buffer.
  writeFileSync(path.join(home, 'flood.cjs'), [
    "const line = 'x'.repeat(999);",
    'for (let i = 0; i < 3000; i++) console.log(line);'
  ].join('\n'));

  const child = fork(TEST_FILE, [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_702_HELPER_DIR: home,
      DC_702_EXIT_CODE_WORKER: '1'
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for start_process exit-code test')), WORKER_TIMEOUT_MS);
      let failure = null;
      child.on('message', (message) => {
        if (message.type === 'done') { clearTimeout(timer); resolve(); }
        else if (message.type === 'failed') { failure = message.message; }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(failure ?? `worker exited ${code} before reporting success`));
      });
    });
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_702_EXIT_CODE_WORKER === '1') {
  await worker();
} else {
  try {
    await parent();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
