/**
 * A process that writes a line in two pieces, for test-prompt-detection.js:
 *   node split-line.js <piece>
 * It writes the first piece of a line with no newline (one ending like a prompt:
 * "<div>", "costs 5$", "see issue #"), then the rest of the output REST_AFTER_MS
 * later, and keeps running. The gap is timed here, from the first piece, so it
 * holds however long the process took to start. It ends on its own after
 * LIFETIME_MS.
 */
const REST_AFTER_MS = 1_000;
const LIFETIME_MS = 60_000;
const PIECES = { markup: '<div>', dollar: 'costs 5$', hash: 'see issue #' };
const [piece] = process.argv.slice(2);

setTimeout(() => process.exit(0), LIFETIME_MS).unref();
process.stdout.write(PIECES[piece]);
setTimeout(() => {
  process.stdout.write(' and the rest of the line\nnext line\n');
  setInterval(() => {}, 1000);
}, REST_AFTER_MS);
