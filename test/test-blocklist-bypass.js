/**
 * Tests for command blocklist bypass fixes
 * Covers: absolute path bypass (#218), command substitution bypass (#217)
 */

import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';

async function runTests() {
    // mock config with blocked commands
    const blockedCmds = ['sudo', 'iptables', 'rm'];

    console.log('Testing extractCommands...\n');

    try {
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

        console.log('\nAll tests passed!');
    } catch (error) {
        console.error('Test failed:', error.message);
        process.exit(1);
    }
}

runTests().catch((error) => {
    console.error('Test execution failed:', error);
    process.exit(1);
});
