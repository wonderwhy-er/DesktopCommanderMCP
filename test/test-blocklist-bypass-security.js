/**
 * Tests for command blocklist bypass security fixes.
 *
 * Covers:
 *   #555  — ${VAR:-default} shell variable expansion bypass
 *   #556  — Newline injection bypass
 *   #580  — Bash process substitution <() and >() bypass
 *   #552  — interactWithProcess missing validateCommand() call
 *
 * These are pure-unit tests against CommandManager (no server needed).
 */

import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';

async function runTests() {
    let passed = 0;
    let failed = 0;

    function ok(condition, label) {
        if (condition) {
            console.log(`  ✅ ${label}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${label}`);
            failed++;
        }
    }

    // ─── #555: ${VAR:-default} variable expansion bypass ─────────────────

    console.log('\n#555 — ${VAR:-default} variable expansion bypass\n');

    // extractCommands should resolve the default value from ${VAR:-default}
    const cmds_555a = commandManager.extractCommands('${SUDO:-sudo} echo hello');
    ok(cmds_555a.includes('sudo'), '${SUDO:-sudo} resolves to "sudo"');

    const cmds_555b = commandManager.extractCommands('${X:-dd} if=/dev/zero of=/tmp/test');
    ok(cmds_555b.includes('dd'), '${X:-dd} resolves to "dd"');

    const cmds_555c = commandManager.extractCommands('${ECHO:-echo} AI_VULN_CANARY');
    ok(cmds_555c.includes('echo'), '${ECHO:-echo} resolves to "echo"');

    // ${VAR-default} (without colon) should also be handled
    const cmds_555d = commandManager.extractCommands('${MISSING-dd} if=/dev/zero of=/tmp/test');
    ok(cmds_555d.includes('dd'), '${MISSING-dd} resolves to "dd"');

    // Plain $VAR should still be skipped (existing behavior preserved)
    const cmds_555e = commandManager.extractCommands('$MYVAR ls');
    ok(cmds_555e.includes('ls'), 'Plain $MYVAR is skipped, "ls" is extracted');
    ok(!cmds_555e.includes('$MYVAR'), '$MYVAR is not treated as a command');

    // Plain ${VAR} without default should still be skipped
    const cmds_555f = commandManager.extractCommands('${MYVAR} ls');
    ok(cmds_555f.includes('ls'), 'Plain ${MYVAR} is skipped, "ls" is extracted');

    // ─── #556: Newline injection bypass ──────────────────────────────────

    console.log('\n#556 — Newline injection bypass\n');

    // Newline should be treated as a command separator
    const cmds_556a = commandManager.extractCommands('echo harmless\ncat /etc/passwd');
    ok(cmds_556a.includes('echo'), 'Extracts "echo" from first line');
    ok(cmds_556a.includes('cat'), 'Extracts "cat" from second line (after \\n)');

    const cmds_556b = commandManager.extractCommands('echo safe\nsudo halt');
    ok(cmds_556b.includes('sudo'), 'Extracts "sudo" from newline-injected command');

    // \r\n should also work
    const cmds_556c = commandManager.extractCommands('echo ok\r\nsudo id');
    ok(cmds_556c.includes('sudo'), 'Extracts "sudo" from \\r\\n separated command');

    // \r alone
    const cmds_556d = commandManager.extractCommands('echo ok\rsudo id');
    ok(cmds_556d.includes('sudo'), 'Extracts "sudo" from \\r separated command');

    // Multiple newline-separated commands
    const cmds_556e = commandManager.extractCommands('echo a\necho b\nsudo halt');
    ok(cmds_556e.includes('sudo'), 'Extracts "sudo" from multi-line command');
    ok(cmds_556e.includes('echo'), 'Also extracts "echo" from earlier lines');

    // ─── #580: Process substitution <() and >() bypass ───────────────────

    console.log('\n#580 — Process substitution <() and >() bypass\n');

    // <() input process substitution
    const cmds_580a = commandManager.extractCommands('cat <(dd if=/dev/zero of=/tmp/test)');
    ok(cmds_580a.includes('dd'), 'Extracts "dd" from <(dd ...)');
    ok(cmds_580a.includes('cat'), 'Also extracts "cat" as the outer command');

    const cmds_580b = commandManager.extractCommands('diff /etc/passwd <(sudo cat /etc/shadow)');
    ok(cmds_580b.includes('sudo'), 'Extracts "sudo" from <(sudo ...)');

    // >() output process substitution
    const cmds_580c = commandManager.extractCommands('echo data > >(dd if=/dev/stdin of=/tmp/out)');
    ok(cmds_580c.includes('dd'), 'Extracts "dd" from >(dd ...)');

    // <() with blocked command
    const cmds_580d = commandManager.extractCommands('cat <(sudo cat /etc/shadow)');
    ok(cmds_580d.includes('sudo'), 'Extracts "sudo" from <(sudo ...) in cat wrapper');

    // Nested process substitution
    const cmds_580e = commandManager.extractCommands('diff <(sudo id) <(sudo whoami)');
    ok(cmds_580e.includes('sudo'), 'Extracts "sudo" from multiple <() substitutions');

    // ─── #552: interactWithProcess input validation (unit-level) ──────────

    console.log('\n#552 — interactWithProcess input validation (unit-level)\n');

    // Direct shell commands as process input ARE caught
    const directPayload = 'sudo halt';
    const cmds_552b = commandManager.extractCommands(directPayload);
    ok(cmds_552b.includes('sudo'), 'Direct shell command "sudo" extracted from process input');

    // Newline injection in process input
    const newlinePayload = 'echo ok\ndd if=/dev/zero of=/tmp/test bs=1 count=1';
    const cmds_552c = commandManager.extractCommands(newlinePayload);
    ok(cmds_552c.includes('dd'), 'Newline-injected "dd" extracted from process input');

    // Chained commands in process input
    const chainPayload = 'echo x; sudo halt';
    const cmds_552d = commandManager.extractCommands(chainPayload);
    ok(cmds_552d.includes('sudo'), 'Semicolon-chained "sudo" extracted from process input');

    // ─── End-to-end: validateCommand should block these attacks ───────────
    // Use commands that are actually in the default blocklist:
    // dd, sudo, mkfs, fdisk, mount, umount, shutdown, reboot, halt, etc.

    console.log('\n--- End-to-end validateCommand checks ---\n');

    // Verify default-blocked commands are actually blocked
    ok(!await commandManager.validateCommand('dd if=/dev/zero of=/tmp/test'), '"dd" is blocked');
    ok(!await commandManager.validateCommand('sudo id'), '"sudo" is blocked');
    ok(!await commandManager.validateCommand('mkfs /dev/sda1'), '"mkfs" is blocked');

    // Variable expansion bypass should now be caught
    ok(!await commandManager.validateCommand('${X:-dd} if=/dev/zero of=/tmp/test'), '${X:-dd} bypass is now blocked');
    ok(!await commandManager.validateCommand('${SUDO:-sudo} halt'), '${SUDO:-sudo} bypass is now blocked');

    // Newline injection should now be caught
    ok(!await commandManager.validateCommand('echo safe\nsudo halt'), 'Newline-injected "sudo" is now blocked');
    ok(!await commandManager.validateCommand('echo safe\ndd if=/dev/zero'), 'Newline-injected "dd" is now blocked');

    // Process substitution should now be caught
    ok(!await commandManager.validateCommand('cat <(sudo cat /etc/shadow)'), '<(sudo ...) substitution is now blocked');
    ok(!await commandManager.validateCommand('echo >(dd if=/dev/zero of=/tmp)'), '>(dd ...) substitution is now blocked');

    // Safe commands should still work
    ok(await commandManager.validateCommand('echo hello'), '"echo hello" is NOT blocked');
    ok(await commandManager.validateCommand('ls -la'), '"ls -la" is NOT blocked');
    ok(await commandManager.validateCommand('cat /etc/hostname'), '"cat /etc/hostname" is NOT blocked');
    ok(await commandManager.validateCommand('node --version'), '"node --version" is NOT blocked');

    // Existing bypass fixes should still work (regression)
    ok(!await commandManager.validateCommand('/usr/bin/sudo ls'), 'Absolute path /usr/bin/sudo still blocked');
    ok(!await commandManager.validateCommand('echo "$(iptables -L)"'), '$() substitution still caught');
    ok(!await commandManager.validateCommand('echo `sudo id`'), 'Backtick substitution still caught');

    // ─── Summary ─────────────────────────────────────────────────────────

    console.log(`\n═══════════════════════════════════════`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`═══════════════════════════════════════\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((error) => {
    console.error('Test execution failed:', error);
    process.exit(1);
});
