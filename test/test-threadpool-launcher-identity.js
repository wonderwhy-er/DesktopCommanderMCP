/** The report must distinguish the thread-pool launcher from an independent nested MCP server. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const requireBuiltin = createRequire(import.meta.url);

const LAUNCHER_ARGUMENT = '--desktop-commander-threadpool-launcher-pid=';
const ENTRY = path.resolve('fixture-package', 'dist', 'index.js');
const bootstrapSource = fs.readFileSync(new URL('../src/utils/threadpool-size.ts', import.meta.url), 'utf8');
const reportSource = fs.readFileSync(new URL('../src/remote-device/diagnostics/report.ts', import.meta.url), 'utf8');

function javascript(source) {
    return ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
}

function server(pid, parentPid, suffix = '') {
    return { pid, parentPid, startedAt: pid * 1000, command: `node "${ENTRY}"${suffix}` };
}

async function count(processes) {
    const start = reportSource.indexOf('function isDesktopCommanderEntry(');
    const end = reportSource.indexOf('\nfunction proxySet(', start);
    assert(start >= 0 && end > start, 'complete actual report count functions must exist');
    const context = vm.createContext({
        fs: { realpathSync: (file) => file,
            readFileSync: () => JSON.stringify({ name: '@wonderwhy-er/desktop-commander' }) },
        path, PACKAGE_NAMES: new Set(['@wonderwhy-er/desktop-commander']),
        NOT_THE_SERVER: new Set(['remote', 'setup', 'remove']), LAUNCHER_PID_ARGUMENT: LAUNCHER_ARGUMENT,
        process: { pid: 9999 }, listProcesses: async () => processes, errorText: String,
    });
    vm.runInContext(javascript(reportSource.slice(start, end)), context);
    return context.desktopCommanderMcp();
}

function bootstrap({ env = {}, args = [], pid = 101, parentPid = 1, binds = true } = {}) {
    const observed = { invocation: null, monitored: false };
    const childProcess = {
        pid, ppid: parentPid, env: { ...env }, argv: ['node', ENTRY, ...args],
        execPath: 'node', execArgv: ['--no-warnings'], exit: () => {},
    };
    const context = vm.createContext({
        exports: {}, process: childProcess,
        require: (name) => {
            if (name === 'child_process') return { spawnSync: (executable, copiedArgs, options) => {
                observed.invocation = { executable, args: [...copiedArgs], options };
                return { status: 0 };
            } };
            if (name === './exit-process.js') return { exitProcess: () => {} };
            if (name === 'net') return {
                createServer: () => ({ on() {}, listen() {}, close() {}, listening: binds }),
                createConnection: () => {
                    observed.monitored = true;
                    const channel = new EventEmitter();
                    channel.unref = channel.resume = channel.destroy = () => {};
                    return channel;
                },
            };
            if (name === 'fs') return { unlinkSync() {} };
            return requireBuiltin(name);
        },
        setInterval: () => { observed.monitored = true; return { unref() {} }; }, clearInterval: () => {},
    });
    vm.runInContext(javascript(bootstrapSource), context);
    context.exports.setThreadpoolSize('16', false);
    return { ...observed, process: childProcess };
}

test('unmarked nested independent servers each count, including legacy ambiguous pairs', async () => {
    assert.equal((await count([server(101, 1), server(102, 101)])).running, 2);
});

test('a marked child counts with its recognized launcher and keeps the earliest start', async () => {
    const observed = await count([server(101, 1), server(102, 101, ` ${LAUNCHER_ARGUMENT}101`)]);
    assert.equal(observed.running, 1);
    assert.equal(observed.since, new Date(101000).toISOString());
});

test('a reused launcher PID with a later start does not hide an independent server', async () => {
    const observed = await count([
        { ...server(101, 1), startedAt: 300000 },
        { ...server(102, 101, ` ${LAUNCHER_ARGUMENT}101`), startedAt: 200000 },
    ]);
    assert.equal(observed.running, 2);
    assert.equal(observed.since, new Date(200000).toISOString());
});

test('a launcher with an unknown start keeps its marked child start', async () => {
    const observed = await count([
        { ...server(101, 1), startedAt: NaN },
        { ...server(102, 101, ` ${LAUNCHER_ARGUMENT}101`), startedAt: 200000 },
    ]);
    assert.equal(observed.running, 1);
    assert.equal(observed.since, new Date(200000).toISOString());
});

test('an independent nested launcher and its marked child count separately from the serving parent', async () => {
    const rows = [server(101, 1), server(102, 101), server(103, 102, ` ${LAUNCHER_ARGUMENT}102`)];
    assert.equal((await count(rows)).running, 2);
});

test('an unmarked independent server below a marked serving child still counts separately', async () => {
    const rows = [server(101, 1), server(102, 101, ` ${LAUNCHER_ARGUMENT}101`), server(103, 102)];
    assert.equal((await count(rows)).running, 2);
});

test('a marker naming a different parent does not collapse an independent server', async () => {
    assert.equal((await count([server(101, 1), server(102, 101, ` ${LAUNCHER_ARGUMENT}999`)])).running, 2);
});

test('only a trailing exact marker is launcher evidence', async () => {
    for (const suffix of [` ${LAUNCHER_ARGUMENT}101 extra`, ` ${LAUNCHER_ARGUMENT}1010`]) {
        assert.equal((await count([server(101, 1), server(102, 101, suffix)])).running, 2);
    }
});

test('a marked child whose launcher is absent still counts', async () => {
    assert.equal((await count([server(102, 101, ` ${LAUNCHER_ARGUMENT}101`)])).running, 1);
});

test('remote, setup, remove, and this reporting process remain excluded', async () => {
    const rows = [server(101, 1), server(102, 101, ' remote'), server(103, 1, ' setup'),
        server(104, 1, ' remove'), server(9999, 1)];
    assert.equal((await count(rows)).running, 1);
});

test('bootstrap appends exactly one marker after the original script arguments', () => {
    const { invocation } = bootstrap({ args: ['remote', '--report', 'user value'] });
    assert.deepEqual(invocation.args, ['--no-warnings', ENTRY, 'remote', '--report', 'user value',
        `${LAUNCHER_ARGUMENT}101`]);
    assert.equal(invocation.options.env.DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID, '101');
    assert.equal(invocation.options.stdio, 'inherit');
});

test('an unrelated inherited launcher marker still configures the Windows pool', () => {
    const observed = bootstrap({ env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '999' } });
    assert.notEqual(observed.invocation, null);
    assert.equal(observed.process.env.UV_THREADPOOL_SIZE, '16');
    assert.equal(observed.monitored, false);
    assert.equal(observed.invocation.options.env.DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID, '101');
});

test('the child consumes only its exact trailing marker and removes inherited launcher identity', () => {
    const marker = `${LAUNCHER_ARGUMENT}101`;
    const observed = bootstrap({ pid: 102, parentPid: 101,
        env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '101',
            DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_CHANNEL: 'lifetime-fixture' },
        args: ['remote', '--report', marker, marker] });
    assert.deepEqual(observed.process.argv.slice(2), ['remote', '--report', marker]);
    assert.equal(observed.process.env.DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID, undefined);
    assert.equal(observed.process.env.DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_CHANNEL, undefined);
    assert.equal(observed.monitored, true);
});

test('a nonmatching or nontrailing application argument survives child bootstrap', () => {
    for (const args of [[`${LAUNCHER_ARGUMENT}999`], [`${LAUNCHER_ARGUMENT}101`, 'user value']]) {
        const observed = bootstrap({ env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '101' }, args });
        assert.deepEqual(observed.process.argv.slice(2), args);
    }
});

test('without launcher environment even an exact-looking application argument survives', () => {
    const args = [`${LAUNCHER_ARGUMENT}101`];
    assert.deepEqual(bootstrap({ env: { UV_THREADPOOL_SIZE: '16' }, args }).process.argv.slice(2), args);
});

test('an unavailable lifetime endpoint falls back without starting a copy', () => {
    const observed = bootstrap({ binds: false });
    assert.equal(observed.invocation, null);
    assert.equal(observed.process.env.UV_THREADPOOL_SIZE, '16');
    assert.equal(observed.monitored, false);
});

test('an unrelated PID-only marker remains unrelated even with its matching application argument', () => {
    const args = [`${LAUNCHER_ARGUMENT}999`];
    const observed = bootstrap({ env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '999' }, args });
    assert.notEqual(observed.invocation, null);
    assert.deepEqual(observed.process.argv.slice(2), args);
    assert.equal(observed.monitored, false);
});

test('an inherited endpoint needs a matching trailing launcher marker to identify a copy', () => {
    const args = [`${LAUNCHER_ARGUMENT}101`];
    const observed = bootstrap({ env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '999',
        DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_CHANNEL: 'lifetime-fixture' }, args });
    assert.notEqual(observed.invocation, null);
    assert.deepEqual(observed.process.argv.slice(2), args);
    assert.equal(observed.monitored, false);
});

test('an inherited endpoint without a launcher PID does not identify a copy', () => {
    const observed = bootstrap({ env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_CHANNEL: 'lifetime-fixture' } });
    assert.notEqual(observed.invocation, null);
    assert.equal(observed.monitored, false);
});
