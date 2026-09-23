/**
 * A minimal line-oriented REPL for the process-state tests. Like python -i
 * and bash -i, it writes its prompt to stderr and its results to stdout.
 *
 * Usage: node stderr-prompt-repl.js [python|shell|node]
 *   The argument picks the prompt: ">>> " (default), "$ " or "> ".
 *
 * Commands, one per input line:
 *   prompt-first <text>   after ANSWER_DELAY_MS, write the prompt to stderr and
 *                         then "<text>\n" to stdout, back to back
 *   output-first <text>   after ANSWER_DELAY_MS, write "<text>\n" to stdout and
 *                         then the prompt to stderr
 *   later-output <text>   write the prompt now and "<text>\n" to stdout
 *                         LATER_OUTPUT_MS later, with no prompt after it
 *   lines <count> <width> write <count> lines of <width> "X"s to stdout, then
 *                         the prompt once stdout has taken them
 *   stream <count> <width> <ms>
 *                         the same lines, spread evenly over <ms> milliseconds
 *                         (one batch every STREAM_TICK_MS), then the prompt
 */
import readline from 'readline';

const PROMPTS = { python: '>>> ', shell: '$ ', node: '> ' };
const PROMPT = PROMPTS[process.argv[2] ?? 'python'];
const ANSWER_DELAY_MS = 150;
const LATER_OUTPUT_MS = 300;
const STREAM_TICK_MS = 20;

const writePrompt = () => process.stderr.write(PROMPT);

function stream(count, width, ms) {
  const line = `${'X'.repeat(width)}\n`;
  const startedAt = Date.now();
  let written = 0;
  const tick = () => {
    const due = ms > 0 ? Math.min(count, Math.ceil(count * (Date.now() - startedAt) / ms)) : count;
    const batch = line.repeat(due - written);
    written = due;
    if (written < count) {
      process.stdout.write(batch);
      setTimeout(tick, STREAM_TICK_MS);
    } else {
      process.stdout.write(batch, writePrompt);
    }
  };
  tick();
}

const commands = {
  'prompt-first': (text) => setTimeout(() => {
    writePrompt();
    process.stdout.write(`${text}\n`);
  }, ANSWER_DELAY_MS),
  'output-first': (text) => setTimeout(() => {
    process.stdout.write(`${text}\n`);
    writePrompt();
  }, ANSWER_DELAY_MS),
  'later-output': (text) => {
    writePrompt();
    setTimeout(() => process.stdout.write(`${text}\n`), LATER_OUTPUT_MS);
  },
  lines: (count, width) => {
    const line = 'X'.repeat(Number(width));
    process.stdout.write(`${line}\n`.repeat(Number(count)), writePrompt);
  },
  stream: (count, width, ms) => stream(Number(count), Number(width), Number(ms)),
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [name, ...args] = line.trim().split(' ');
  const command = commands[name];
  if (command) {
    command(...(name === 'lines' || name === 'stream' ? args : [args.join(' ')]));
  } else {
    process.stdout.write(`unknown command: ${line}\n`);
    writePrompt();
  }
});

writePrompt();
