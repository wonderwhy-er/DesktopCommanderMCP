/**
 * The AI review's budget (test/ci-review.js run): Gemini CLI's BeforeTool hook, which
 * runs before every tool call. The first N calls go through; every later one is refused
 * with a reason the model reads, so it answers from what it has read. (A refusal keeps the
 * answer; Gemini CLI's own turn stop, model.maxSessionTurns, ends the session without one.
 * A BeforeToolSelection hook's toolConfig mode NONE didn't stop the reads in 0.66.0.)
 *
 *   node test/ci-review-budget.js <state file> <N>      (Gemini CLI passes the call on stdin)
 */
import fs from 'fs';

const [state, limit] = process.argv.slice(2);
// The call itself isn't needed, only that one more is on its way
fs.readFileSync(0);
let calls = 0;
try {
  calls = Number(fs.readFileSync(state, 'utf8')) || 0;
} catch {
  // The first call: no state yet
}
calls += 1;
fs.writeFileSync(state, String(calls));
process.stdout.write(JSON.stringify(calls > Number(limit)
  ? { decision: 'deny', reason: `Your reading budget is used up (${limit} tool calls). Answer now, from what you have read, with the JSON object only.` }
  : {}));
