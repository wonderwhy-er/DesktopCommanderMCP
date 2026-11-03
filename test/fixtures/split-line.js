/**
 * A process that writes a line in two pieces, for test-prompt-detection.js:
 *   node split-line.js <trigger> <piece>
 * It writes the first piece of a line with no newline (one ending like a prompt:
 * "<div>", "costs 5$", "see issue #"), then the rest of the output once the test
 * creates <trigger>, and keeps running. It ends on its own after LIFETIME_MS.
 */
import fs from 'fs';

const LIFETIME_MS = 15_000;
const PIECES = { markup: '<div>', dollar: 'costs 5$', hash: 'see issue #' };
const [trigger, piece] = process.argv.slice(2);

setTimeout(() => process.exit(0), LIFETIME_MS).unref();
process.stdout.write(PIECES[piece]);
const poll = setInterval(() => {
  if (!fs.existsSync(trigger)) return;
  clearInterval(poll);
  process.stdout.write(' and the rest of the line\nnext line\n');
  setInterval(() => {}, 1000);
}, 20);
