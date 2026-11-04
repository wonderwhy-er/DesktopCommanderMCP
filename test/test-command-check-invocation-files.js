import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { commandManager } from '../dist/command-manager.js';
import { isTestHome } from './helpers/test-env.js';

before(() => assert.ok(isTestHome(), 'Run through test/run-all-tests.js with a fresh test home'));

const file = (what) => ({ what, inFile: true });
const runtime = (what) => ({ what, inFile: false });

const cases = [
  ['PowerShell abbreviated version mode does not execute a trailing file',
    'pwsh -ver ignored.ps1', []],
  ['PowerShell short version prefix does not execute a trailing file',
    'pwsh -ve ignored.ps1', []],
  ['Windows PowerShell version abbreviation consumes its version before command text',
    'powershell -Ver 5.1 -Command "Write-Output deploy.ps1"', []],
  ['Windows PowerShell version abbreviation preserves the actual script file',
    'powershell -Ver 5.1 -File deploy.ps1', [file('deploy.ps1')]],
  ['Bash clustered POSIX option suppresses startup and is not a script file',
    'bash --rcfile startup.sh -io posix -c "echo ready"', []],
  ['Bash clustered shopt option consumes its value before command text',
    'bash --rcfile startup.sh -iO extglob -c "echo ready"', [file('startup.sh')]],
  ['Bash processes interactive mode after a separate command flag',
    'bash --rcfile startup.sh -c -i "echo ready"', [file('startup.sh')]],
  ['Bash processes login mode after the command flag',
    'bash --rcfile ignored.sh -ic -l "echo ready"', []],
  ['PowerShell interactive flag preserves its literal default file',
    'pwsh -i deploy.ps1', [file('deploy.ps1')]],
  ['PowerShell interactive flag preserves its runtime default file',
    'pwsh -i "$SCRIPT"', [runtime('pwsh')]],
  ['PowerShell execution-policy alias consumes its value',
    'pwsh -ep Bypass -File deploy.ps1', [file('deploy.ps1')]],
  ['PowerShell working-directory alias does not become a file',
    'pwsh -wd scripts.ps1 -Command "echo ready"', []],
  ['PowerShell input-format alias consumes its value',
    'pwsh -if XML -File deploy.ps1', [file('deploy.ps1')]],
  ['PowerShell output-format alias consumes its value',
    'pwsh -of XML -Command "echo ready"', []],
  ['Bash reads an explicit startup file even with command text',
    'bash --rcfile ./startup.sh -ic "echo ready"', [file('./startup.sh')]],
  ['Bash accepts the init-file startup alias and a path containing spaces',
    'bash --init-file "./startup file.sh" -ic "echo ready"', [file('./startup file.sh')]],
  ['Bash reports a startup filename chosen at runtime',
    'bash --rcfile "$RC" -ic "echo ready"', [runtime('bash')]],
  ['Bash uses only the final explicit startup file',
    'bash --rcfile ignored.sh --rcfile active.sh -ic "echo ready"', [file('active.sh')]],
  ['Bash norc suppresses an explicit startup file',
    'bash --rcfile ignored.sh --norc -ic "echo ready"', []],
  ['Bash login mode does not read the rcfile',
    'bash --rcfile ignored.sh --login -ic "echo ready"', []],
  ['Bash POSIX mode does not read the rcfile',
    'bash --rcfile ignored.sh --posix -ic "echo ready"', []],
  ['Noninteractive Bash command mode does not read the rcfile',
    'bash --rcfile ignored.sh -c "echo ready"', []],
  ['Bash reports both startup and main script files when both are read',
    'bash --rcfile startup.sh -i script.sh', [file('startup.sh'), file('script.sh')]],
  ['Bash does not treat a command argument as an interactive option',
    'bash --rcfile ignored.sh -c "echo ready" -i', []],
  ['PowerShell default file mode reports a filename chosen at runtime',
    'pwsh "$SCRIPT"', [runtime('pwsh')]],
  ['PowerShell flags do not hide its runtime-selected default file',
    'pwsh -NoProfile "$SCRIPT"', [runtime('pwsh')]],
  ['PowerShell explicit file mode still reports a runtime-selected file',
    'pwsh -File "$SCRIPT"', [runtime('pwsh')]],
  ['PowerShell command text ending in ps1 is not a script file',
    'pwsh -Command "Get-Content file.ps1"', []],
  ['PowerShell abbreviated command mode does not label its text as a file',
    'pwsh -c "Write-Output deploy.ps1"', []],
  ['Windows PowerShell command mode uses the same text boundary',
    'powershell -Command "Write-Output deploy.ps1"', []],
  ['PowerShell command-with-args does not classify a command argument as a file',
    'pwsh -CommandWithArgs "Write-Output" deploy.ps1', []],
  ['PowerShell encoded command mode does not classify text as a file',
    'pwsh -EncodedCommand "deploy.ps1"', []],
  ['PowerShell skips execution-policy values before an explicit file',
    'pwsh -ExecutionPolicy Bypass -File deploy.ps1', [file('deploy.ps1')]],
  ['PowerShell skips execution-policy values before its default file',
    'pwsh -ExecutionPolicy Bypass deploy.ps1', [file('deploy.ps1')]],
  ['PowerShell working-directory values are not script files',
    'pwsh -WorkingDirectory scripts.ps1 -Command "echo ready"', []],
  ['PowerShell finds a runtime-selected file after its working directory',
    'pwsh -WorkingDirectory scripts.ps1 "$SCRIPT"', [runtime('pwsh')]],
  ['PowerShell script arguments are not additional script files',
    'pwsh -File deploy.ps1 script-argument.ps1', [file('deploy.ps1')]],
  ['PowerShell File stdin is not a script filename',
    'pwsh -File -', []],
];

for (const [name, command, unseen] of cases) {
  test(name, async () => {
    // Only the outer Bash text is parsed; none of these input commands runs.
    const answer = await commandManager.checkCommand(command, 'bash');
    assert.equal(answer.verdict, unseen.length ? 'unseen' : 'allowed', JSON.stringify(answer));
    assert.deepEqual(answer.unseen ?? [], unseen);
  });
}
