/**
 * Tests for command blocklist bypass fixes
 * Covers: absolute path bypass (#218), command substitution bypass (#217),
 * newline-separated commands bypass (#933, #957, #976)
 */

import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { exitProcess } from '../dist/utils/exit-process.js';
import { skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

/** Asserts that bash running `command` is refused for `name` */
async function assertBlocked(command, name) {
    const check = await commandManager.checkCommand(command, 'bash');
    console.log(`  ${command} =>`, check);
    assert.deepStrictEqual([check.verdict, check.name], ['blocked', name], `FAIL: should block "${name}" in ${command}`);
}

async function runTests() {
    // Sets blockedCommands, so only in a fresh test home
    if (!isTestHome()) {
        skip('test-blocklist-bypass.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-blocklist-bypass.js');
        return;
    }
    await configManager.setValue('blockedCommands', ['sudo', 'iptables', 'rm']);

    console.log('Testing checkCommand and extractCommands...\n');

    try {
        // Test 1: absolute path should be normalized
        await assertBlocked('/usr/bin/sudo ls', 'sudo');

        // Test 2: $() command substitution inside quotes
        await assertBlocked('echo "$(iptables -L)"', 'iptables');

        // Test 3: backtick substitution
        await assertBlocked('echo `rm -rf /`', 'rm');

        // Test 4: normal command still works
        const cmds4 = commandManager.extractCommands('ls -la /home');
        console.log('  ls -la /home =>', cmds4);
        assert.ok(cmds4.includes('ls'), 'FAIL: should extract "ls" normally');

        // Test 5: nested $() inside $()
        const cmds5 = commandManager.extractCommands('echo $(cat $(which sudo))');
        console.log('  echo $(cat $(which sudo)) =>', cmds5);
        assert.ok(cmds5.includes('cat'), 'FAIL: should extract "cat" from nested $()');

        // Test 6: path with env var prefix
        await assertBlocked('HOME=/tmp /usr/sbin/iptables', 'iptables');

        // Test 7: backtick substitution inside quotes
        await assertBlocked('echo "`/usr/bin/sudo`"', 'sudo');

        // Test 8: dollar-prefixed tokens should be ignored
        const cmds8 = commandManager.extractCommands('$MYVAR ls');
        console.log('  $MYVAR ls =>', cmds8);
        assert.ok(cmds8.includes('ls'), 'FAIL: should extract "ls" and ignore $MYVAR');
        assert.ok(!cmds8.includes('$MYVAR'), 'FAIL: should not include $MYVAR as a command');

        // Test 9: newline-separated commands are separate commands (#933, #957, #976)
        const cmds9 = commandManager.extractCommands('echo ok\nrm -rf /tmp/x');
        console.log('  echo ok\\nrm -rf /tmp/x =>', cmds9);
        assert.ok(cmds9.includes('echo'), 'FAIL: should extract "echo" before the newline');
        assert.ok(cmds9.includes('rm'), 'FAIL: should extract "rm" after a newline separator');

        // Test 10: CRLF line endings (Windows)
        const cmds10 = commandManager.extractCommands('echo ok\r\nsudo reboot');
        console.log('  echo ok\\r\\nsudo reboot =>', cmds10);
        assert.ok(cmds10.includes('sudo'), 'FAIL: should extract "sudo" after a CRLF separator');

        // Test 11: lone CR line endings
        const cmds11 = commandManager.extractCommands('echo ok\riptables -L');
        console.log('  echo ok\\riptables -L =>', cmds11);
        assert.ok(cmds11.includes('iptables'), 'FAIL: should extract "iptables" after a CR separator');

        // Test 12: a newline inside quotes is data, not a separator
        const cmds12 = commandManager.extractCommands('echo "line one\nline two"');
        console.log('  echo "line one\\nline two" =>', cmds12);
        assert.deepStrictEqual(cmds12, ['echo'], 'FAIL: a quoted newline must stay part of the argument');

        // Test 13: newline chained with a blocked command in the middle
        const cmds13 = commandManager.extractCommands('ls\nrm -rf /\n&& echo done');
        console.log('  ls\\nrm -rf /\\n&& echo done =>', cmds13);
        assert.ok(cmds13.includes('rm'), 'FAIL: should extract "rm" from a multi-line chain');

        console.log('\nAll tests passed!');
    } catch (error) {
        console.error('Test failed:', error.message);
        exitProcess(1);
    }
}

runTests().catch((error) => {
    console.error('Test execution failed:', error);
    exitProcess(1);
});
