/**
 * The PowerShell helper starts with the user's profile, as the PowerShell a
 * command runs in does (Desktop Commander starts it without -NoProfile), and
 * a profile can't spoil its answers:
 *   - a profile's alias comes before a function: with Set-Alias net net.exe in
 *     the profile, `function net { 'x' }; net user` runs net.exe, so it is
 *     blocked; an alias of another name leaves the script's own function alone
 *   - text the profile prints without a newline doesn't hide the first answer
 *   - lines the profile prints in the shape of answers aren't taken as answers
 *   - the profile's functions and aliases with the names of the cmdlets the
 *     helper calls don't replace them
 *
 * Each case writes a profile into this test home, where each PowerShell looks
 * for it ($PROFILE.CurrentUserCurrentHost: Windows PowerShell finds it only
 * when the home has a Documents folder), and then starts new helpers. Skipped
 * without Windows PowerShell or PowerShell 7.
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { installedPowerShells } from './helpers/powershell.js';
import { waitUntil } from './helpers/wait.js';

const BLOCKED_NET = { verdict: 'blocked', name: 'net' };
const ALLOWED = { verdict: 'allowed' };

const CASES = [
  {
    what: "a profile's alias comes before the script's own function",
    profile: 'Set-Alias net net.exe',
    checks: [["function net { 'x' }; net user", BLOCKED_NET]],
  },
  {
    what: 'a profile alias of another name leaves the own function alone',
    profile: 'Set-Alias hostname hostname.exe',
    checks: [["function net { 'x' }; net user", ALLOWED]],
  },
  {
    what: 'text the profile prints without a newline',
    profile: "Write-Host -NoNewline 'profile text without a newline'",
    checks: [['net user', BLOCKED_NET], ['Get-Date', ALLOWED]],
  },
  {
    // The checks' ids count up across helper starts; the profile fakes an answer for each of the first 1000
    what: 'lines the profile prints in the shape of answers',
    profile: `1..1000 | ForEach-Object { '{"id":' + $_ + ',"commands":[],"functions":[]}' }`,
    checks: [['net user', BLOCKED_NET], ['shutdown /a', { verdict: 'blocked', name: 'shutdown' }]],
  },
  {
    // Each stand-in changes an answer or stops the helper when the helper calls it by its plain name
    what: "the profile's functions and aliases with the names of the helper's cmdlets",
    profile: [
      'Set-Alias net net.exe',
      'function Import-Module { }',
      'function New-Object { }',
      "function Get-Command { [pscustomobject]@{ CommandType = 'Alias'; Definition = 'Get-Date' } }",
      "function ConvertFrom-Json { [pscustomobject]@{ id = 0; command = '' } }",
      "function ConvertTo-Json { '{}' }",
      'Set-Alias Where-Object Write-Output',
      'Set-Alias Get-Alias Out-Null',
    ].join('\n'),
    checks: [
      ['net user', BLOCKED_NET],
      ["function net { 'x' }; net user", BLOCKED_NET],
      ["function shutdown { 'x' }; shutdown /a", ALLOWED],
    ],
  },
];

/** Where `shell` looks for the current user's profile, in this test home */
function profilePath(shell) {
  // Windows PowerShell has no $PROFILE without the home's Documents folder
  fs.mkdirSync(path.join(os.homedir(), 'Documents'), { recursive: true });
  const found = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'], { encoding: 'utf8' }).trim();
  assert.ok(found.startsWith(os.homedir() + path.sep), `${shell}'s profile is in the test home: ${found}`);
  return found;
}

export default async function runTests() {
  // It writes profiles into the home and sets blockedCommands, so only in a fresh test home
  if (!isTestHome()) {
    skip('test-powershell-profile.js writes PowerShell profiles into the home; run it through the runner: node test/run-all-tests.js test-powershell-profile.js');
    return true;
  }
  const shells = installedPowerShells();
  if (shells.length === 0) {
    skip('PowerShell profile: neither powershell nor pwsh is installed here');
    return true;
  }
  const { commandManager } = await import('../dist/command-manager.js');
  const { runningPowerShellHelpers } = await import('../dist/utils/powershell-commands.js');
  await configManager.setValue('blockedCommands', ['net', 'shutdown']);
  const profiles = shells.map(profilePath);

  const failures = [];
  let checks = 0;
  for (const [n, testCase] of CASES.entries()) {
    console.log(`Test ${n + 1}: ${testCase.what}`);
    for (const file of profiles) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, testCase.profile + '\n');
    }
    // The helpers read the profile when they start: stop the running ones, the next check starts new ones
    for (const pid of runningPowerShellHelpers()) process.kill(pid);
    await waitUntil(() => runningPowerShellHelpers().length === 0, 10000, 'the helpers have ended');
    for (const shell of shells) {
      for (const [command, expected] of testCase.checks) {
        const answer = await commandManager.checkCommand(command, shell);
        const right = JSON.stringify(answer) === JSON.stringify(expected);
        checks++;
        console.log(`  ${right ? '✓' : '✗'} ${shell}: ${command} → ${JSON.stringify(answer)}`);
        if (!right) failures.push(`${testCase.what} (${shell}): ${command} should be ${JSON.stringify(expected)} but was ${JSON.stringify(answer)}`);
      }
    }
  }
  console.log(failures.length === 0 ? `All ${checks} checks right` : `${failures.length} of ${checks} checks wrong:\n  ${failures.join('\n  ')}`);
  assert.deepStrictEqual(failures, [], `${failures.length} of ${checks} PowerShell profile checks are wrong`);
  return true;
}

runIfMain(import.meta.url, runTests);
