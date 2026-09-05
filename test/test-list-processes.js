/**
 * Tests for listProcesses parsing (#662): Windows tasklist output was parsed
 * with ps-aux column logic, garbling every field. Parsers are pure and
 * platform-independent, so both are tested everywhere; a live smoke runs on
 * the current platform only.
 */
import assert from 'assert';
import os from 'os';
import { parseWindowsTasklistCsv, parsePsAux, listProcesses } from '../dist/tools/process.js';

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ PASS  ${name}`); }
  catch (e) { failures++; console.log(`🔴 FAIL  ${name}\n   ${e.message}`); }
}

// CRLF line endings and quoted CSV, exactly as tasklist /FO CSV /NH emits.
const TASKLIST_CSV = [
  '"System Idle Process","0","Services","0","8 K"',
  '"System","4","Services","0","21,436 K"',
  '"Claude Helper.exe","14004","Console","1","155,200 K"',
  '"node.exe","76844","Console","1","113,672 K"',
  '',
].join('\r\n');

// ps aux with header row and a command containing spaces.
const PS_AUX = [
  'USER  PID %CPU %MEM    VSZ   RSS TTY STAT START TIME COMMAND',
  'root    1  0.0  0.1 168000 11000 ?   Ss   Jan01 0:04 /sbin/init splash',
  'edu  8794  1.2  0.5 409000 82000 ?   S    10:15 0:01 node dist/index.js remote --debug',
  '',
].join('\n');

await test('tasklist CSV: image name, pid, memory land in the right fields', () => {
  const rows = parseWindowsTasklistCsv(TASKLIST_CSV);
  assert.strictEqual(rows.length, 4);
  const system = rows.find(r => r.pid === 4);
  assert.strictEqual(system.command, 'System');
  assert.strictEqual(system.memory, '21,436 K');
  assert.strictEqual(system.cpu, 'n/a');
});

await test('tasklist CSV: image names with spaces stay intact (no column shift)', () => {
  const helper = parseWindowsTasklistCsv(TASKLIST_CSV).find(r => r.pid === 14004);
  assert.strictEqual(helper.command, 'Claude Helper.exe');
  assert.strictEqual(helper.memory, '155,200 K');
});

await test('tasklist CSV: session name/number never leak into cpu/memory', () => {
  for (const r of parseWindowsTasklistCsv(TASKLIST_CSV)) {
    assert.ok(!['Services', 'Console'].includes(r.cpu), `cpu leaked session name: ${r.cpu}`);
    assert.ok(!['0', '1'].includes(r.memory), `memory leaked session number: ${r.memory}`);
  }
});

await test('tasklist table output (the old command) yields no NaN garbage rows', () => {
  // Regression guard for the header/separator symptom from #662: even if fed
  // the wrong format, the parser must drop unparsable rows, not emit NaN.
  const legacyTable = 'Image Name  PID Session Name  Session#  Mem Usage\r\n=========== === ============ ========= =========\r\nSystem   4 Services 0 21,436 K\r\n';
  const rows = parseWindowsTasklistCsv(legacyTable);
  assert.ok(rows.every(r => !Number.isNaN(r.pid)));
});

await test('ps aux: commands with spaces are rejoined, not truncated to last token', () => {
  const rows = parsePsAux(PS_AUX);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].command, 'node dist/index.js remote --debug');
  assert.strictEqual(rows[1].cpu, '1.2');
  assert.strictEqual(rows[1].memory, '0.5');
});

await test('ps aux: CRLF input leaves no trailing-\\r empty column', () => {
  const rows = parsePsAux(PS_AUX.replace(/\n/g, '\r\n'));
  assert.strictEqual(rows[0].command, '/sbin/init splash');
});

await test(`live smoke on ${os.platform()}: real output parses with no NaN/empty rows`, async () => {
  const result = await listProcesses();
  assert.ok(!result.isError, 'listProcesses returned error');
  const lines = result.content[0].text.split('\n');
  assert.ok(lines.length > 5, 'suspiciously few processes');
  assert.ok(lines.every(l => !l.includes('PID: NaN')), 'NaN pid rows present');
  assert.ok(lines.every(l => !/Command: ,/.test(l)), 'empty command rows present');
});

console.log(failures > 0 ? `🔴 list-processes: ${failures} failing test(s).` : '✅ list-processes: 0 failing test(s).');
process.exit(failures > 0 ? 1 : 0);
