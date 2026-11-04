/** Parser-only FOR /F regression. None of these command strings is executed. */
import assert from 'node:assert/strict';
import { readCmdCommands } from '../dist/utils/cmd-commands.js';
import { runIfMain } from './helpers/run-if-main.js';

const cases = [
  ["for /f %i in ('sc stop Spooler') do @echo %i", ['sc', 'echo']],
  ["for /f \"tokens=*\" %%i in ('net user') do @echo %%i", ['net', 'echo']],
  ['FOR /F "usebackq tokens=*" %i in (`sc query`) DO @echo %i', ['sc', 'echo']],
  ["for,/f %i in ('sc query') do @echo %i", ['sc', 'echo']],
  ["for=/f %i in ('sc query') do @echo %i", ['sc', 'echo']],
  ["for;/f %i in ('sc query') do @echo %i", ['sc', 'echo']],
  ["for /f %i in ('^sc query') do @echo %i", ['sc', 'echo']],
  ["for /f %i in ('s^c query') do @echo %i", ['sc', 'echo'], 's^c'],
  ['if exist x (for /f %i in (\'sc query\') do @echo %i)', ['sc', 'echo']],
  ['for /f %i in (\'echo x ^| sc query\') do @echo %i', ['echo', 'sc', 'echo']],
  ['for /f %i in (\'(echo x ^& sc query)\') do @echo %i', ['echo', 'sc', 'echo']],
  ['for /f %i in (\'echo "sc"\') do @echo %i', ['echo', 'echo']],
  ['for /f %i in ("sc query") do @echo %i', ['echo']],
  ["for /f \"usebackq\" %i in ('sc query') do @echo %i", ['echo']],
  ['for /f "usebackq" %i in ("sc query.txt") do @echo %i', ['echo']],
  ["for %i in ('sc query') do @echo %i", ['echo']],
];

export default async function runTests() {
  const failures = [];
  for (const [text, expected, escapedName] of cases) {
    const result = await readCmdCommands(text);
    try {
      assert.equal(result.parseError, undefined);
      assert.deepEqual(result.commands.map(c => c.name), expected);
      for (const command of result.commands) {
        if (escapedName && command.name === 'sc') {
          assert.equal(command.start, text.indexOf(escapedName));
          continue;
        }
        assert.equal(text.slice(command.start).replace(/^@/, '').startsWith(command.name), true,
          `wrong source offset for ${command.name}: ${command.start}`);
      }
    } catch (error) { failures.push(`${text}: ${error.message}`); }
  }
  const malformed = await readCmdCommands("for /f %i in ('sc query) do @echo %i");
  assert.equal(malformed.commands.length, 0);
  assert.match(malformed.parseError, /for \/f quoted set is not closed/);
  assert.deepEqual(failures, []);
  console.log(`PASS: ${cases.length} FOR /F command/literal/offset controls`);
  return true;
}

runIfMain(import.meta.url, runTests);
