/**
 * Tests for command blocklist bypass fixes
 * Covers: absolute path bypass (#218), command substitution bypass (#217),
 * interact_with_process bypass (#552)
 */

import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { forceTerminate, interactWithProcess, startProcess } from '../dist/tools/improved-process-tools.js';
import { exitProcess } from '../dist/utils/exit-process.js';
import { pythonCommand } from './helpers/python.js';

function extractPid(result) {
    const match = result.content[0].text.match(/Process started with PID (\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

async function assertFileDoesNotExist(filePath, message) {
    await assert.rejects(
        fs.access(filePath),
        error => error.code === 'ENOENT',
        message
    );
}

async function testCommandExtraction() {
    console.log('Testing extractCommands...\n');

    // Test 1: absolute path should be normalized
    const cmds1 = commandManager.extractCommands('/usr/bin/sudo ls');
    console.log('  /usr/bin/sudo ls =>', cmds1);
    assert.ok(cmds1.includes('sudo'), 'FAIL: should extract "sudo" from absolute path');

    // Test 2: $() command substitution inside quotes
    const cmds2 = commandManager.extractCommands('echo "$(iptables -L)"');
    console.log('  echo "$(iptables -L)" =>', cmds2);
    assert.ok(cmds2.includes('iptables'), 'FAIL: should extract "iptables" from $() inside quotes');

    // Test 3: backtick substitution
    const cmds3 = commandManager.extractCommands('echo `rm -rf /`');
    console.log('  echo `rm -rf /` =>', cmds3);
    assert.ok(cmds3.includes('rm'), 'FAIL: should extract "rm" from backticks');

    // Test 4: normal command still works
    const cmds4 = commandManager.extractCommands('ls -la /home');
    console.log('  ls -la /home =>', cmds4);
    assert.ok(cmds4.includes('ls'), 'FAIL: should extract "ls" normally');

    // Test 5: nested $() inside $()
    const cmds5 = commandManager.extractCommands('echo $(cat $(which sudo))');
    console.log('  echo $(cat $(which sudo)) =>', cmds5);
    assert.ok(cmds5.includes('cat'), 'FAIL: should extract "cat" from nested $()');

    // Test 6: path with env var prefix
    const cmds6 = commandManager.extractCommands('HOME=/tmp /usr/sbin/iptables');
    console.log('  HOME=/tmp /usr/sbin/iptables =>', cmds6);
    assert.ok(cmds6.includes('iptables'), 'FAIL: should extract "iptables" from path with env');

    // Test 7: backtick substitution inside quotes
    const cmds7 = commandManager.extractCommands('echo "`/usr/bin/sudo`"');
    console.log('  echo "`/usr/bin/sudo`" =>', cmds7);
    assert.ok(cmds7.includes('sudo'), 'FAIL: should extract "sudo" from backticks inside quotes');

    // Test 8: dollar-prefixed tokens should be ignored
    const cmds8 = commandManager.extractCommands('$MYVAR ls');
    console.log('  $MYVAR ls =>', cmds8);
    assert.ok(cmds8.includes('ls'), 'FAIL: should extract "ls" and ignore $MYVAR');
    assert.ok(!cmds8.includes('$MYVAR'), 'FAIL: should not include $MYVAR as a command');

    // Test 9: a newline starts a new command, with LF or CRLF endings
    for (const separator of ['\n', '\r\n']) {
        const cmds9 = commandManager.extractCommands(`echo ok${separator}dd if=/dev/zero`);
        console.log(`  echo ok${JSON.stringify(separator)}dd if=/dev/zero =>`, cmds9);
        assert.ok(cmds9.includes('dd'), 'FAIL: should extract "dd" from the second line');
    }

    // Test 10: a newline inside quotes is not a separator
    const cmds10 = commandManager.extractCommands('echo "one\nsudo two"');
    console.log('  echo "one\\nsudo two" =>', cmds10);
    assert.ok(!cmds10.includes('sudo'), 'FAIL: should not split a quoted newline');

    // Test 11: an escaped newline continues the same command
    const cmds11 = commandManager.extractCommands('echo one \\\nsudo');
    console.log('  echo one \\<newline>sudo =>', cmds11);
    assert.ok(!cmds11.includes('sudo'), 'FAIL: should not split a line continuation');
}

async function testInteractWithProcessValidation(tempDir) {
    console.log('\nTesting interactWithProcess blocked command validation...');

    const blockedCommands = ['sudo', 'iptables', 'rm', 'dd'];
    await configManager.setValue('blockedCommands', blockedCommands);

    const startCanary = path.join(tempDir, 'start-process-canary');
    const blockedStart = await startProcess({
        command: `dd if=/dev/zero of=${startCanary} bs=1 count=1`,
        timeout_ms: 1000
    });
    assert.strictEqual(blockedStart.isError, true, 'startProcess should reject dd');
    assert.match(blockedStart.content[0].text, /Command not allowed/, 'startProcess should return its blocked-command error');
    await assertFileDoesNotExist(startCanary, 'startProcess must not execute a blocked command');

    const multilineCanary = path.join(tempDir, 'multiline-start-canary');
    const blockedMultilineStart = await startProcess({
        command: `echo ok\ndd if=/dev/zero of=${multilineCanary} bs=1 count=1`,
        timeout_ms: 1000
    });
    assert.strictEqual(blockedMultilineStart.isError, true, 'startProcess should reject dd on a later line');
    await assertFileDoesNotExist(multilineCanary, 'startProcess must not execute a blocked command on a later line');

    const python = pythonCommand();
    if (!python) {
        console.log('  Python not available, skipping the interactive checks');
        return;
    }

    const startResult = await startProcess({
        command: `${python} -i`,
        timeout_ms: 5000
    });
    const pid = extractPid(startResult);
    assert.ok(pid, `Failed to start Python REPL: ${startResult.content[0].text}`);

    try {
        const benignResult = await interactWithProcess({
            pid,
            input: '2 + 2',
            timeout_ms: 3000
        });
        assert.ok(!benignResult.isError, 'Benign input should be forwarded');
        assert.match(benignResult.content[0].text, /\b4\b/, 'Benign input should produce normal REPL output');

        for (const input of ['', '   ']) {
            const emptyResult = await interactWithProcess({
                pid,
                input,
                timeout_ms: 3000
            });
            assert.ok(!emptyResult.isError, `${JSON.stringify(input)} input should be forwarded unchanged`);
        }

        const interactCanary = path.join(tempDir, 'interact-process-canary');
        const blockedInput = `import os; os.system("$(dd if=/dev/zero of=${interactCanary} bs=1 count=1)")`;
        const blockedResult = await interactWithProcess({
            pid,
            input: blockedInput,
            timeout_ms: 3000
        });

        assert.strictEqual(blockedResult.isError, true, 'Blocked interactive input should return an error');
        assert.strictEqual(
            blockedResult.content[0].text,
            'Input rejected: contains blocked command.',
            'Blocked interactive input should return the expected rejection message'
        );
        await assertFileDoesNotExist(interactCanary, 'Rejected input must not be written to process stdin');

        const blockedMultiline = await interactWithProcess({
            pid,
            input: `print("ok")\ndd if=/dev/zero of=${interactCanary} bs=1 count=1`,
            timeout_ms: 3000
        });
        assert.strictEqual(blockedMultiline.isError, true, 'A blocked command on a later line should be rejected');
        assert.strictEqual(
            blockedMultiline.content[0].text,
            'Input rejected: contains blocked command.',
            'Multiline input should return the expected rejection message'
        );

        const blockedSudoStart = await startProcess({ command: 'sudo --version' });
        const blockedSudoInput = await interactWithProcess({ pid, input: 'sudo --version' });
        assert.strictEqual(blockedSudoStart.isError, true, 'startProcess should reject sudo');
        assert.strictEqual(blockedSudoInput.isError, true, 'interactWithProcess should also reject sudo');
    } finally {
        await forceTerminate({ pid });
    }
}

async function runTests() {
    const originalConfig = await configManager.getConfig();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-blocklist-'));

    try {
        await testCommandExtraction();
        await testInteractWithProcessValidation(tempDir);
        console.log('\nAll tests passed!');
    } finally {
        await configManager.updateConfig(originalConfig);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

runTests().catch((error) => {
    console.error('Test failed:', error.message);
    exitProcess(1);
});
