/**
 * The AI review's budget (test/ci-review.js run): Gemini CLI's BeforeTool hook, which
 * runs before every tool call. The first N calls go through; every later one is refused
 * with a reason the model reads, so it answers from what it has read. (A refusal keeps the
 * answer; Gemini CLI's own turn stop, model.maxSessionTurns, ends the session without one.
 * A BeforeToolSelection hook's toolConfig mode NONE didn't stop the reads in 0.66.0.)
 * A text check's shell commands are refused too, unless they're plain read-only git or gh:
 * Gemini CLI's own allowlist (tools.core) checks them first, and this checks every word.
 *
 *   node test/ci-review-budget.js <state file> <N>      (Gemini CLI passes the call on stdin)
 */
import fs from 'fs';

const [state, limit] = process.argv.slice(2);
// Read-only git and gh on this repository, in plain words: no quotes, no shell characters
const COMMAND = /^(git (log|show|rev-parse|merge-base)|gh (pr|run) view)( [\w.,:/^~=@%+-]+)*$/;
// Words that would write a file, run a configured program, or reach another repository
const REFUSED = [/^--output(=|$)/, /^--(ext-diff|textconv)$/, /^-[OR]/, /^--repo(=|$)/, /^--web$/, /^-w$/];
const plainCommand = (command) => COMMAND.test(command) && !command.split(' ').some((word) => REFUSED.some((refused) => refused.test(word)));

let call = {};
try {
  call = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  // No call to read: it's counted all the same
}
let calls = 0;
try {
  calls = Number(fs.readFileSync(state, 'utf8')) || 0;
} catch {
  // The first call: no state yet
}
calls += 1;
fs.writeFileSync(state, String(calls));
const command = call.tool_name === 'run_shell_command' ? String(call.tool_input?.command ?? '').trim() : null;
let answer = {};
if (calls > Number(limit)) {
  answer = { decision: 'deny', reason: `Your reading budget is used up (${limit} tool calls). Answer now, from what you have read, with the JSON object only.` };
} else if (command !== null && !plainCommand(command)) {
  answer = { decision: 'deny', reason: 'Only plain git log, git show, git rev-parse or git merge-base, or gh pr view or gh run view, run here: no other command, '
    + 'no quotes or shell characters, and no --output, --ext-diff, --textconv, -O, -R, --repo or --web.' };
}
process.stdout.write(JSON.stringify(answer));
