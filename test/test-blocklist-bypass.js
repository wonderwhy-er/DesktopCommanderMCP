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

        // Test 9: 'export' prefix should not mask the real command
        const cmds9 = commandManager.extractCommands('export PATH=/usr/bin rm -rf /');
        console.log('  export PATH=/usr/bin rm -rf / =>', cmds9);
        assert.ok(cmds9.includes('rm'), 'FAIL: should extract "rm" past an export prefix');
        assert.ok(!cmds9.includes('export'), 'FAIL: should not extract "export" as the command');

        // Test 10: quoted env var value (containing a space) should not desync tokenization
        const cmds10 = commandManager.extractCommands('FOO="a b" rm -rf /');
        console.log('  FOO="a b" rm -rf / =>', cmds10);
        assert.ok(cmds10.includes('rm'), 'FAIL: should extract "rm" past a quoted env var value');

        // Test 11: multiple leading env var assignments
        const cmds11 = commandManager.extractCommands('A=1 B=2 rm -rf /');
        console.log('  A=1 B=2 rm -rf / =>', cmds11);
        assert.ok(cmds11.includes('rm'), 'FAIL: should extract "rm" past multiple env var assignments');

        // Test 12: reasonable nesting still parses correctly (not affected by depth limit)
        const cmds12 = commandManager.extractCommands('$($($(rm -rf /)))');
        console.log('  $($($(rm -rf /))) =>', cmds12);
        assert.ok(cmds12.includes('rm'), 'FAIL: should extract "rm" from reasonably nested $()');

        // Test 13: excessive nesting depth must fail closed (throw) rather than
        // silently returning an empty/incomplete result that could bypass validateCommand
        const deeplyNested = '$('.repeat(25) + 'rm -rf /' + ')'.repeat(25);
        assert.throws(
            () => commandManager.extractCommands(deeplyNested),
            'FAIL: should throw when nesting depth exceeds the limit, not fail open'
        );
        console.log('  25 levels of $() nesting => throws as expected (fail closed)');

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
