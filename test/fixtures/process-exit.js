/**
 * Processes for test-process-exit.js, one per mode:
 *   node process-exit.js <mode> [trigger]
 * A trigger is a file path: the fixture takes its next step once the test
 * creates that file, so no case depends on how fast the machine is.
 *
 *   late-writer <trigger>     starts itself as print-late, sharing its stdout,
 *                             and exits: the output comes after the exit
 *   print-late <trigger>      prints "written after the exit" once <trigger> exists
 *   two-lines <trigger>       prints "line one", then "line two" once <trigger>
 *                             exists, and exits
 *   open-line <trigger>       writes "ready>" with no newline, appends " more"
 *                             to that line once <trigger> exists, keeps running
 *   error-then-run            prints "Error: still working" and keeps running;
 *                             answers each input line with "Error: retrying <line>"
 *
 * Every mode ends on its own after LIFETIME_MS, so a failing test leaves
 * nothing running.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';

const LIFETIME_MS = 15_000;
const [mode, trigger] = process.argv.slice(2);

setTimeout(() => process.exit(0), LIFETIME_MS).unref();

/** Runs `then` once the trigger file exists */
function onTrigger(then) {
  const poll = setInterval(() => {
    if (!fs.existsSync(trigger)) return;
    clearInterval(poll);
    then();
  }, 20);
}

const keepRunning = () => setInterval(() => {}, 1000);

function onInputLine(answer) {
  readline.createInterface({ input: process.stdin }).on('line', answer);
}

const modes = {
  'late-writer': () => {
    const self = fileURLToPath(import.meta.url);
    spawn(process.execPath, [self, 'print-late', trigger], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
    console.log('writer started');
  },
  'print-late': () => onTrigger(() => console.log('written after the exit')),
  'two-lines': () => {
    console.log('line one');
    onTrigger(() => console.log('line two'));
  },
  'open-line': () => {
    process.stdout.write('ready>');
    onTrigger(() => process.stdout.write(' more'));
    keepRunning();
  },
  'error-then-run': () => {
    console.log('Error: still working');
    onInputLine((line) => console.log(`Error: retrying ${line}`));
  },
};

if (!modes[mode]) {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
modes[mode]();
