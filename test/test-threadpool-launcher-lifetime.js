import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/utils/threadpool-size.ts', import.meta.url), 'utf8');

function servingCopy() {
    const channel = new EventEmitter();
    const exits = [];
    let checkPid;
    let unreferenced = false;
    channel.unref = () => { unreferenced = true; };
    const context = vm.createContext({
        exports: {},
        process: {
            pid: 102, ppid: 101,
            env: { DESKTOP_COMMANDER_THREADPOOL_LAUNCHER_PID: '101' },
            argv: ['node', 'entry.js', '--desktop-commander-threadpool-launcher-pid=101'],
            // The PID has been reused: signal 0 succeeds even after the original launcher died.
            kill: () => {},
        },
        require: (name) => {
            if (name === 'child_process') return {};
            if (name === 'net') return { Socket: function () { return channel; } };
            if (name === './exit-process.js') return { exitProcess: code => exits.push(code) };
            throw new Error(`Unexpected dependency: ${name}`);
        },
        setInterval: (check) => { checkPid = check; return { unref() { unreferenced = true; } }; },
        clearInterval: () => {},
    });
    vm.runInContext(ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
    context.exports.setThreadpoolSize('16', false);
    return { channel, exits, checkPid, unreferenced };
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
