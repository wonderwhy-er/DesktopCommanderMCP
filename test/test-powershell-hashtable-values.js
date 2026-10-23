/**
 * Regression tests for #834: quoted PowerShell hashtable values are not
 * environment assignments, so their words must not become commands.
 */

import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';
import { exitProcess } from '../dist/utils/exit-process.js';

async function runTests() {
    console.log('Testing quoted hashtable values in extractCommands...\n');

    try {
        // Test 1: the reported false positive - a descriptive hashtable value
        const reported = `$metadata = [ordered]@{ Stage='preflight'; Operation='Device init then read-only health check' }; $metadata | ConvertTo-Json`;
        const cmds1 = commandManager.extractCommands(reported);
        console.log('  reported hashtable =>', cmds1);
        assert.ok(!cmds1.includes('init'), 'FAIL: quoted hashtable text must not be extracted as a command');

        // Test 2: a lone quoted property value
        const cmds2 = commandManager.extractCommands(`Operation='Device init then read-only health check'`);
        console.log(`  Operation='Device init ...' =>`, cmds2);
        assert.ok(!cmds2.includes('init'), 'FAIL: quoted value must not be split into commands');

        // Test 3: real init invocations are still extracted
        assert.ok(commandManager.extractCommands('init').includes('init'),
            'FAIL: bare init must still be extracted');
        assert.ok(commandManager.extractCommands('/usr/bin/init').includes('init'),
            'FAIL: init behind a path must still be extracted');
        assert.ok(commandManager.extractCommands('init; ls').includes('init'),
            'FAIL: separated init must still be extracted');

        // Test 4: real environment assignments are still stripped
        assert.ok(commandManager.extractCommands('FOO=1 init').includes('init'),
            'FAIL: bare env value must still be stripped');
        assert.ok(commandManager.extractCommands('FOO="a b" init').includes('init'),
            'FAIL: quoted env value must still be stripped');

        // Test 5: command substitution inside a quoted value is still checked
        assert.ok(commandManager.extractCommands(`Operation='$(init)'`).includes('init'),
            'FAIL: $() must still be extracted from a quoted value');

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
