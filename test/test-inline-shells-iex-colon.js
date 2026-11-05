/** Invoke-Expression colon binding and shared option readings; parse-only, no programs run. */
import assert from 'node:assert/strict';
import { sameShellTexts, shellRuns } from '../dist/utils/inline-shells.js';
import { runIfMain } from './helpers/run-if-main.js';

function command(words, wordTexts = words.map(word => word ?? '$CMD'), name = words[0]) {
  return { name, words, wordTexts, written: wordTexts, start: 0, nameAtRunTime: false };
}

export default function runTests() {
  const cases = [
    [['iex', '-c:', 'Get-Date'], { texts: ['Get-Date'] }],
    [['iex', '-Command:', 'Get-Date'], { texts: ['Get-Date'] }],
    [['iex', '—c:', 'Get-Date'], { texts: ['Get-Date'] }],
    [['iex', '-c:', null], { texts: ['$CMD'], file: null }],
    [['iex', '-c:Get-Date'], { texts: ['iex Get-Date'] }],
    [['iex', '-Command:Get-Date'], { texts: ['iex Get-Date'] }],
    [['iex', 'Get-Date'], { texts: ['Get-Date'] }],
    [['iex', null], { texts: ['$CMD'], file: null }],
    [['iex'], { texts: [], file: null }],
    [['iex', '-ErrorAction', 'Stop', 'Get-Date'], { texts: ['Stop', 'Get-Date'] }],
  ];
  for (const [words, expected] of cases) {
    assert.deepEqual(sameShellTexts(command(words, undefined, 'Invoke-Expression'), 'powershell'), expected, JSON.stringify(words));
  }
  assert.deepEqual(shellRuns(command(['bash', '-c', 'echo ready'])), { texts: ['echo ready'] });
  assert.deepEqual(shellRuns(command(['bash', 'deploy.sh'])), { texts: [], file: 'deploy.sh' });
  assert.deepEqual(shellRuns(command(['bash', '-c', null])), { texts: ['$CMD'], file: null });
  assert.deepEqual(shellRuns(command(['watch', 'echo', 'ready'])), { texts: ['echo ready'], shell: 'sh' });
  assert.deepEqual(sameShellTexts(command(['gsudo', 'echo', 'ready']), 'posix'), { texts: ['echo ready'] });
  assert.deepEqual(sameShellTexts(command(['gsudo', '!!']), 'posix'), { texts: [], file: null });
  assert.deepEqual(sameShellTexts(command(['eval', 'echo', 'ready']), 'posix'), { texts: ['echo ready'] });
  console.log(`PASS: ${cases.length + 7} colon/runtime/pipeline/option-reading cases; no commands executed`);
  return true;
}

runIfMain(import.meta.url, runTests);

