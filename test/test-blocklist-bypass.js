/**
 * Tests for command blocklist bypass fixes
 * Covers: absolute path bypass (#218), command substitution bypass (#217)
 */

const { commandManager } = require('../dist/command-manager.js');

async function runTests() {
    // mock config with blocked commands
    const blockedCmds = ['sudo', 'iptables', 'rm'];

    console.log('Testing extractCommands...\n');

    // Test 1: absolute path should be normalized
    const cmds1 = commandManager.extractCommands('/usr/bin/sudo ls');
    console.log('  /usr/bin/sudo ls =>', cmds1);
    console.assert(cmds1.includes('sudo'), 'FAIL: should extract "sudo" from absolute path');

    // Test 2: $() command substitution
    const cmds2 = commandManager.extractCommands('echo "$(iptables -L)"');
    console.log('  echo "$(iptables -L)" =>', cmds2);
    console.assert(cmds2.includes('iptables'), 'FAIL: should extract "iptables" from $()');

    // Test 3: backtick substitution
    const cmds3 = commandManager.extractCommands('echo `rm -rf /`');
    console.log('  echo `rm -rf /` =>', cmds3);
    console.assert(cmds3.includes('rm'), 'FAIL: should extract "rm" from backticks');

    // Test 4: normal command still works
    const cmds4 = commandManager.extractCommands('ls -la /home');
    console.log('  ls -la /home =>', cmds4);
    console.assert(cmds4.includes('ls'), 'FAIL: should extract "ls" normally');

    // Test 5: nested $() inside $()
    const cmds5 = commandManager.extractCommands('echo $(cat $(which sudo))');
    console.log('  echo $(cat $(which sudo)) =>', cmds5);
    console.assert(cmds5.includes('cat'), 'FAIL: should extract "cat" from nested $()');

    // Test 6: path with env var prefix
    const cmds6 = commandManager.extractCommands('HOME=/tmp /usr/sbin/iptables');
    console.log('  HOME=/tmp /usr/sbin/iptables =>', cmds6);
    console.assert(cmds6.includes('iptables'), 'FAIL: should extract "iptables" from path with env');

    console.log('\nAll tests passed!');
}

runTests().catch(console.error);
