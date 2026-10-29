/**
 * The PowerShell helper starts with the user's profile, as the PowerShell a
 * command runs in does (Desktop Commander starts it without -NoProfile), and
 * a profile can't spoil its answers:
 *   - a profile's alias comes before a function: with Set-Alias net net.exe in
 *     the profile on Windows, or Set-Alias net /usr/bin/net on other systems,
 *     `function net { 'x' }; net user` runs the program net, so it is blocked;
 *     an alias of another name leaves the script's own function alone
 *   - text the profile prints without a newline doesn't hide the first answer
 *   - lines the profile prints in the shape of answers aren't taken as answers
 *   - the profile's functions and aliases with the names of the cmdlets the
 *     helper calls don't replace them
 *   - the profile's aliases named like the helper's own functions don't
 *     replace those
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

// Each stand-in changes an answer or stops the helper when the helper calls it by its plain name
const CMDLET_STAND_INS = [
  'function Import-Module { }',
  'function New-Object { }',
  "function Get-Command { [pscustomobject]@{ CommandType = 'Alias'; Definition = 'Get-Date' } }",
  "function ConvertFrom-Json { [pscustomobject]@{ id = 0; command = '' } }",
  "function ConvertTo-Json { '{}' }",
  'Set-Alias Where-Object Write-Output',
  'Set-Alias Get-Alias Out-Null',
];
const CMDLET_CHECKS = [
  ['net user', BLOCKED_NET],
  ["function net { 'x' }; net user", BLOCKED_NET],
  ["function shutdown { 'x' }; shutdown /a", ALLOWED],
];

// What a profile alias named like one of the helper's own functions runs instead: a program name
// nothing blocks, the word without its drive name (net for function:net), and "no". Each one lets the
// case's command through.
const OWN_FUNCTION_STAND_INS = [
  "function Get-HarmlessName { 'Get-Date' }",
  "function Get-WordWithoutDrive { $args[0].Extent.Text -replace '^\\w+:', '' }",
  'function Test-Never { $false }',
];

// A case with `windows: true` runs on Windows only, one with `windows: false` everywhere else. An alias to
// net.exe runs the program net on Windows only, and one to /usr/bin/net on the other systems.
const CASES = [
  {
    what: "a profile's alias to net.exe comes before the script's own function",
    windows: true,
    profile: 'Set-Alias net net.exe',
    checks: [["function net { 'x' }; net user", BLOCKED_NET]],
  },
  {
    what: "a profile's alias to /usr/bin/net comes before the script's own function",
    windows: false,
    profile: 'Set-Alias net /usr/bin/net',
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
    what: "the profile's functions and aliases with the names of the helper's cmdlets, and an alias to net.exe",
    windows: true,
    profile: ['Set-Alias net net.exe', ...CMDLET_STAND_INS].join('\n'),
    checks: CMDLET_CHECKS,
  },
  {
    what: "the profile's functions and aliases with the names of the helper's cmdlets, and an alias to /usr/bin/net",
    windows: false,
    profile: ['Set-Alias net /usr/bin/net', ...CMDLET_STAND_INS].join('\n'),
    checks: CMDLET_CHECKS,
  },
  {
    what: 'a profile alias named Get-Meaning',
    profile: [...OWN_FUNCTION_STAND_INS, 'Set-Alias Get-Meaning Get-HarmlessName'].join('\n'),
    checks: [['net user', BLOCKED_NET]],
  },
  {
    what: 'a profile alias named Get-WordValue',
    profile: [...OWN_FUNCTION_STAND_INS, 'Set-Alias Get-WordValue Get-WordWithoutDrive'].join('\n'),
    checks: [["function net { 'x' }; Remove-Item function:net; net user", BLOCKED_NET]],
  },
  {
    what: 'a profile alias named Test-RemovesFunction',
    profile: [...OWN_FUNCTION_STAND_INS, 'Set-Alias Test-RemovesFunction Test-Never'].join('\n'),
    checks: [["function net { 'x' }; Remove-Item function:net; net user", BLOCKED_NET]],
  },
  {
    what: 'a profile alias named Test-RunsUnreadCode',
    profile: [...OWN_FUNCTION_STAND_INS, 'Set-Alias Test-RunsUnreadCode Test-Never'].join('\n'),
    checks: [["function net { 'x' }; Invoke-Expression $text; net user", BLOCKED_NET]],
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
    if (testCase.windows === true && process.platform !== 'win32') {
      skip(`PowerShell profile, ${testCase.what}: Windows only`);
      continue;
    }
    if (testCase.windows === false && process.platform === 'win32') {
      skip(`PowerShell profile, ${testCase.what}: not on Windows`);
      continue;
    }
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
