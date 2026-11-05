/**
 * Compatibility hook for the former Gemini CLI review runner, retained for its
 * subprocess regression tests. The active Claude review runner enforces its
 * tool budget in test/helpers/claude-review.js and does not invoke this hook.
 * The first N calls go through; later calls are refused with a readable reason.
 * Legacy shell calls allow only plain read-only git or gh commands.
 *
 *   node test/ci-review-budget.js <state file> <N>      (legacy tool call on stdin)
 */
import fs from 'fs';

const [state, limit] = process.argv.slice(2);
// Read-only git and gh on this repository, in plain words: no quotes, no shell characters
const COMMAND = /^(git (log|show|rev-parse|merge-base)|gh (pr|run) view)( [\w.,:/^~=@%+-]+)*$/;
// Words that would write a file, run a configured program, or reach another repository
const REFUSED = [/^--output(=|$)/, /^--(ext-diff|textconv)$/, /^-[OR]/, /^--repo(=|$)/, /^--web$/, /^-w$/];
const refusedWord = (word) => REFUSED.some((refused) => refused.test(word));
const plainCommand = (command) => COMMAND.test(command) && !command.split(' ').some(refusedWord);

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
  answer = {
    decision: 'deny',
    reason: `Your reading budget is used up (${limit} tool calls). `
      + 'Answer now, from what you have read, with the JSON object only.',
  };
} else if (command !== null && !plainCommand(command)) {
  answer = {
    decision: 'deny',
    reason: 'Only plain git log, git show, git rev-parse or git merge-base, or gh pr view or gh run view, run here: '
      + 'no other command, no quotes or shell characters, '
      + 'and no --output, --ext-diff, --textconv, -O, -R, --repo or --web.',
  };
}
process.stdout.write(JSON.stringify(answer));
