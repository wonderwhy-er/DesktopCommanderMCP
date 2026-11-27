// Failed runs: detection from output, exit codes that arrive later (linked by PID to their run), runs stopped on
// purpose, a cd that failed, and what the card says about them.
import path from 'path';
import { setup, mk, ok, q, checker, allOf, projectLine } from './harness.mjs';

const t = await setup({ prefix: 'dc3-' });
const { H, dc } = t;
const { check, section, done } = checker();
const shop = mk(path.join(H, 'code', 'shop'), { 'package.json': JSON.stringify({ name: 'shop', description: 'Online store for ceramics', scripts: { start: 'node server.js' } }), 'server.js': '//' });
t.writeJournal([]);
const started = (pid, out) => `Process started with PID ${pid} (shell: bash)\nInitial output:\n${out}`;
const crash = started(4242, "node:fs:441\nError: ENOENT: no such file or directory, open 'C:\\\\shop\\\\data\\\\catalog.json'\n  code: 'ENOENT'\nNode.js v22.9.0\n\n✅ Process 4242 has finished execution");
const running = (pid) => started(pid, 'shop listening on :3000\n\n⏳ Process is running. Use read_process_output to get more output.');
const okDone = started(4444, '3 passed\n\n✅ Process 4444 has finished execution');
const logsError = started(4545, '[warn] retrying\nTypeError: x is undefined (handled)\nserver up\n\n⏳ Process is running. Use read_process_output to get more output.');

section('reading the output');
check('crash right after start = failed', dc.failedOutput(crash));
check('still running = not failed', !dc.failedOutput(running(4343)));
check('finished cleanly = not failed', !dc.failedOutput(okDone));
check('error text while still running = not failed', !dc.failedOutput(logsError));
check('exit code 1 = failed', dc.failedOutput('Process completed with exit code 1'));
check('exit code 0 = not failed', !dc.failedOutput('Process completed with exit code 0'));

section('recording');
const rowsSince = (n) => t.journal().slice(n);
dc.observeToolCall('start_process', { command: `node ${q(path.join(shop, 'server.js'))}` }, ok(crash), false);
check('crashed start recorded as failed node', t.journal().some((r) => r.verb === 'node' && r.failed && r.run), t.journal());

let n = t.journal().length;
dc.observeToolCall('start_process', { command: `npm test --prefix ${q(shop)}` }, ok(running(5151)), false);
check('running start: one npm test row, not failed', rowsSince(n).length === 1 && allOf(rowsSince(n), (r) => r.verb === 'npm test' && !r.failed), rowsSince(n));
const testRun = rowsSince(n)[0];
dc.observeToolCall('read_process_output', { pid: 5151 }, ok('[Reading 3 new lines]\n\n1 failed\n✅ Process completed with exit code 1 (runtime: 2.1s)'), false);
const late = t.journal().at(-1);
check('later exit code linked by PID, written for that run (same id and start time)', late.verb === 'npm test' && late.failed && late.run === testRun.run && late.t === testRun.t && path.resolve(late.root).toLowerCase() === shop.toLowerCase(), late);
n = t.journal().length;
dc.observeToolCall('read_process_output', { pid: 9999 }, ok('✅ Process completed with exit code 1'), false);
check('unknown PID adds nothing', t.journal().length === n, rowsSince(n));

n = t.journal().length;
dc.observeToolCall('start_process', { command: `node ${q(path.join(shop, 'server.js'))}` }, ok(running(6161)), false);
check('the second node start was tracked (one row, not failed)', rowsSince(n).length === 1 && allOf(rowsSince(n), (r) => r.verb === 'node' && !r.failed), rowsSince(n));
const m = t.journal().length;
dc.observeToolCall('force_terminate', { pid: 6161 }, ok('Successfully initiated termination of session 6161'), false);
dc.observeToolCall('read_process_output', { pid: 6161 }, ok('✅ Process completed with exit code 1'), false);
check('stopped on purpose: the exit after it adds no failure', t.journal().length === m, rowsSince(m));

section('a late failure of an older run does not hide a newer run');
const api = mk(path.join(H, 'code', 'api'), { 'package.json': '{"name":"api"}' });
dc.observeToolCall('start_process', { command: `cd ${q(api)} && npm test` }, ok(running(7001)), false);        // run A
dc.observeToolCall('start_process', { command: `cd ${q(api)} && npm test` }, ok(started(7002, '5 passed\n✅ Process completed with exit code 0')), false); // run B, passed
dc.observeToolCall('read_process_output', { pid: 7001 }, ok('✅ Process completed with exit code 1'), false);  // A's failure arrives after B
const apiDetail = projectLine(dc.handleGetDeviceContext({}, {}).content[0].text, api);
check('api: the latest run (B) passed, so no "last run failed"', apiDetail && !apiDetail.includes('last run failed'), apiDetail);
const solo = mk(path.join(H, 'code', 'solo'), { 'package.json': '{"name":"solo"}' });
dc.observeToolCall('start_process', { command: `cd ${q(solo)} && npm test` }, ok(running(7003)), false);
dc.observeToolCall('read_process_output', { pid: 7003 }, ok('✅ Process completed with exit code 1'), false);
const soloLine = projectLine(dc.handleGetDeviceContext({ limit: 10 }, {}).content[0].text, solo);
check('solo: a late failure with no newer run is shown', /last run failed: `npm test`/.test(soloLine), soloLine);

section('a cd that failed');
const ghost = path.join(H, 'code', 'not-there');
n = t.journal().length;
dc.observeToolCall('start_process', { command: `cd ${q(path.join(api, 'missing'))} && npm test` }, ok(`bash: cd: ${path.join(api, 'missing')}: No such file or directory\nProcess completed with exit code 1`), false);
check('cd into a missing folder: the test never ran, nothing failed', allOf(rowsSince(n), (r) => !r.failed), rowsSince(n));
n = t.journal().length;
dc.observeToolCall('start_process', { command: `cd ${q(ghost)} && npm test` }, ok('Process completed with exit code 1'), false);
check('...also when only the missing folder tells', rowsSince(n).every((r) => !r.failed), rowsSince(n));

section('the card');
const out = dc.handleGetDeviceContext({}, {}).content[0].text;
check('tool returns the resume card', /^💡 Recent work on this device/.test(out) && out.includes('Last session') && out.includes(shop), out);
// the shop's own line, not any "(failed)" on the card: the node crash earlier must not stand in for the npm test failure
const shopLine = projectLine(out, shop);
check('shop line: last run failed is npm test (the failure linked by PID)', /last run failed: [^\n]*`npm test` \(\d{4}-/.test(shopLine), shopLine || out);
check('shop line: node is not listed as failed (its latest run was stopped on purpose)', !/last run failed: [^\n]*`node`/.test(shopLine), shopLine);
check('card has the project description', shopLine.includes('Online store for ceramics'), shopLine);
const detail = dc.handleGetDeviceContext({ project: 'shop' }, {}).content[0].text;
check('project arg gives the detail view', detail.includes(shop) && (detail.includes('recent files') || detail.includes('commands')), detail);
console.log('\n--- card ---\n' + out + '\n');
done();
