import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';

const source = fs.readFileSync(new URL('../src/utils/threadpool-size.ts', import.meta.url), 'utf8');
const requireBuiltin = createRequire(import.meta.url);

function servingCopy({ endpoint = 'lifetime-fixture', parentPid = 101 } = {}) {
    const channel = new EventEmitter();
    const exits = [];
    const connections = [];
    let checkPid;
    let unreferenced = false;
    channel.unref = () => { unreferenced = true; };
    channel.resume = () => {};
    channel.destroy = () => {};
    const context = vm.createContext({
        exports: {},
        process: {
            pid: 102, ppid: parentPid, platform: 'win32',
            env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '101',
                DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_CHANNEL: endpoint, UV_THREADPOOL_SIZE: '16' },
            argv: ['node', 'entry.js', '--desktop-commander-threadpool-launcher-pid=101'],
            // The PID has been reused: signal 0 succeeds even after the original launcher died.
            kill: () => {},
        },
        require: (name) => {
            if (name === 'child_process') return {};
            if (name === 'net') return {
                createConnection: endpoint => {
                    connections.push(endpoint);
                    return channel;
                },
            };
            if (name === './exit-process.js') return { exitProcess: code => exits.push(code) };
            return requireBuiltin(name);
        },
        setInterval: (check) => { checkPid = check; return { unref() { unreferenced = true; } }; },
        clearInterval: () => {},
    });
    vm.runInContext(ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
    context.exports.setThreadpoolSize('16', false);
    return { channel, exits, checkPid, unreferenced, connections, process: context.process };
}

test('the copy ends when its original launcher channel closes even if its PID is live again', () => {
    const copy = servingCopy();
    copy.checkPid?.();
    copy.channel.emit('end');
    assert.deepEqual(copy.exits, [1]);
});

test('a live launcher channel leaves the serving copy running without keeping its event loop alive', () => {
    const copy = servingCopy();
    copy.checkPid?.();
    assert.deepEqual(copy.exits, []);
    assert.equal(copy.unreferenced, true);
});

test('a broken lifetime channel ends the copy without relying on the live PID', () => {
    const copy = servingCopy();
    copy.channel.emit('error', new Error('original channel is gone'));
    assert.deepEqual(copy.exits, [1]);
});

test('a closing lifetime channel requests the exit only once', () => {
    const copy = servingCopy();
    copy.channel.emit('end');
    copy.channel.emit('error', new Error('connection closed'));
    assert.deepEqual(copy.exits, [1]);
});

test('a marked copy without its lifetime endpoint stops instead of trusting its PID', () => {
    const copy = servingCopy({ endpoint: '' });
    assert.deepEqual(copy.exits, [1]);
});

test('a copy reparented before bootstrap still observes its original launcher channel', () => {
    const copy = servingCopy({ parentPid: 1 });
    assert.deepEqual(copy.connections, ['lifetime-fixture']);
    copy.channel.emit('error', new Error('original launcher died before bootstrap'));
    assert.deepEqual(copy.exits, [1]);
    assert.deepEqual(Array.from(copy.process.argv), ['node', 'entry.js']);
});
