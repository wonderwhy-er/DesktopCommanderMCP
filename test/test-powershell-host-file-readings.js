/** Parser-only host-option/file regressions; no shell or supplied command is executed. */
import assert from 'node:assert/strict';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const cases = [
    [['pwsh', '–c', 'Get-Date'], []],
    [['pwsh', '-Command', 'Get-Date'], []],
    [['pwsh', '/Command', 'Get-Date'], []],
    [['pwsh', '-File', 'deploy.ps1'], [{ what: 'deploy.ps1', inFile: true }]],
    [['pwsh', '-File', null], [{ what: 'pwsh', inFile: false }]],
    [['pwsh', '-ver', 'ignored.ps1'], []],
    [['powershell', '-Ver', '5.1', '-File', 'deploy.ps1'], [{ what: 'deploy.ps1', inFile: true }]],
  ];
  for (const [words, expected] of cases) {
    const found = { name: words[0], words, written: words.map(w => w ?? '$FILE'),
      wordTexts: words.map(w => w ?? '$FILE'), start: 0, nameAtRunTime: false };
    assert.deepEqual(commandManager.scriptFiles(found, 'posix'), expected, JSON.stringify(words));
  }
  console.log('PASS: seven actual manager host-file readings; no command execution');
  return true;
}
runIfMain(import.meta.url, runTests);
