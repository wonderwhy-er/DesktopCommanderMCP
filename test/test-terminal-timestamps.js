import assert from 'node:assert/strict';
import { startTerminalTimestamps } from '../dist/utils/terminal-timestamps.js';
import { runIfMain } from './helpers/run-if-main.js';

export function runTests() {
    const RealDate = Date;
    let now = new RealDate(2026, 0, 2, 3, 4, 5);
    const stdout = [];
    const stderr = [];
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = methods.map((method) => [method, console[method]]);
    let stop;
    try {
        globalThis.Date = class extends RealDate {
            constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
        };
        process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
        process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
        stop = startTerminalTimestamps();

        for (const method of methods) console[method]('%s %d', method, 42);
        console.log('\nfirst\nsecond\n');
        console.log();
        console.log({ answer: 42 });
        const error = new Error('failure');
        console.error(error);
        now = new RealDate(2026, 0, 3, 0, 0, 1);
        console.log('after midnight');

        assert.deepEqual(stdout.slice(0, 5), [
            '[03:04:05] log 42\n',
            '[03:04:05] info 42\n',
            '[03:04:05] debug 42\n',
            '\n[03:04:05] first\n[03:04:05] second\n\n',
            '\n',
        ]);
        assert.match(stdout[5].replace(/\x1b\[[0-9;]*m/g, ''), /^\[03:04:05\] \{ answer: 42 \}\n$/);
        assert.equal(stdout[6], '[00:00:01] after midnight\n');
        assert.deepEqual(stderr.slice(0, 2), ['[03:04:05] warn 42\n', '[03:04:05] error 42\n']);
        assert.equal(stderr[2].replace(/\x1b\[[0-9;]*m/g, ''), error.stack.split('\n').map((line) => `[03:04:05] ${line}`).join('\n') + '\n');

        process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
        assert.equal(stdout.at(-1), '{"jsonrpc":"2.0","id":1,"result":{}}\n', 'protocol writes stay untouched');
    } finally {
        stop?.();
        globalThis.Date = RealDate;
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
    }
    for (const [method, original] of originals) assert.equal(console[method], original);
    console.log('✅ Terminal timestamps: all levels, formatting, multiline output, local time, midnight, protocol writes, and cleanup');
}

runIfMain(import.meta.url, runTests);
