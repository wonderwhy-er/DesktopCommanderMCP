#!/usr/bin/env node

/**
 * Test exitProcess(), the product's single way to end the process on purpose.
 *
 * process.exit() right after a fetch() download aborts Node on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
 * src\win\async.c", exit code 0xC0000409) while V8 still compiles the HTTP
 * parser's WebAssembly on a background thread. exitProcess() lets Node exit
 * on its own and only forces the exit after EXIT_GRACE_MS.
 *
 * Each case runs in its own Node process:
 *   - nothing keeps the process alive: it exits with the code, before the grace period
 *   - a handle keeps it alive: it exits with the code once the grace period is over
 *   - a second call does not change the code
 *   - stdout written before the call arrives in full
 *   - right after a fetch() download it exits with the code, run after run
 */

import assert from 'assert';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { EXIT_GRACE_MS } from '../dist/utils/exit-process.js';
import { runIfMain } from './helpers/run-if-main.js';

const HELPER_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'utils', 'exit-process.js')).href;
/** Slack for a loaded machine on top of the grace period */
const TIMING_SLACK_MS = 2000;
const FETCH_RUNS = 10;

/**
 * Runs `body` as an ES module in a new Node process with exitProcess imported.
 * Resolves with the process's exit code, its stdout, and what its 'exit'
 * listener saw: the code and how long after the start of `body` it ran.
 */
function runChild(body, env = {}) {
    const source = [
        `import fs from 'fs';`,
        `import { exitProcess } from ${JSON.stringify(HELPER_URL)};`,
        `const started = Date.now();`,
        `process.on('exit', (code) => fs.writeSync(1, '\\n' + JSON.stringify({ code, ms: Date.now() - started })));`,
        body,
    ].join('\n');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', reject);
        child.on('close', (code) => {
            const lastLine = stdout.slice(stdout.lastIndexOf('\n') + 1);
            let exitListener = null;
            try {
                exitListener = JSON.parse(lastLine);
            } catch {
                // No 'exit' listener output: the process aborted
            }
            resolve({ code, stdout: stdout.slice(0, stdout.lastIndexOf('\n')), stderr, exitListener });
        });
    });
}

async function testExitsOnItsOwn() {
    const run = await runChild('exitProcess(3);');
    assert.strictEqual(run.code, 3, `exit code, stderr: ${run.stderr}`);
    assert.strictEqual(run.exitListener?.code, 3, "the 'exit' listener should see the code");
    assert.ok(run.exitListener.ms < EXIT_GRACE_MS,
        `with nothing left to do the process should exit before the ${EXIT_GRACE_MS}ms grace period, took ${run.exitListener.ms}ms`);
    console.log(`✓ nothing keeps it alive: exit 3 after ${run.exitListener.ms}ms`);
}

async function testHandleKeepsItAliveUntilGraceEnds() {
    const run = await runChild('setInterval(() => {}, 60_000); exitProcess(4);');
    assert.strictEqual(run.code, 4, `exit code, stderr: ${run.stderr}`);
    assert.strictEqual(run.exitListener?.code, 4, "the 'exit' listener should see the code");
    assert.ok(run.exitListener.ms >= EXIT_GRACE_MS && run.exitListener.ms < EXIT_GRACE_MS + TIMING_SLACK_MS,
        `a handle should keep the process alive for the ${EXIT_GRACE_MS}ms grace period and no longer, took ${run.exitListener.ms}ms`);
    console.log(`✓ an open handle: exit 4 after ${run.exitListener.ms}ms`);
}

async function testFirstCallWins() {
    const run = await runChild('exitProcess(5); exitProcess(6);');
    assert.strictEqual(run.code, 5, `exit code, stderr: ${run.stderr}`);
    console.log('✓ a second call keeps the first exit code');
}

async function testStdoutIsFlushed() {
    const size = 1 << 20;
    const run = await runChild(`process.stdout.write('x'.repeat(${size})); setInterval(() => {}, 60_000); exitProcess(0);`);
    assert.strictEqual(run.code, 0, `exit code, stderr: ${run.stderr}`);
    assert.strictEqual(run.stdout.length, size, 'everything written to stdout before exitProcess() should arrive');
    console.log(`✓ ${size} bytes written to stdout before the call all arrived`);
}

async function testExitRightAfterFetch() {
    // A few MB in chunks: the download that makes V8 compile the parser in the background
    const chunk = Buffer.alloc(64 * 1024, 'x');
    const server = http.createServer((request, response) => {
        for (let i = 0; i < 64; i++) response.write(chunk);
        response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const url = `http://127.0.0.1:${server.address().port}/`;
        const body = 'const response = await fetch(process.env.DOWNLOAD_URL); await response.arrayBuffer(); exitProcess(7);';
        const codes = [];
        for (let i = 0; i < FETCH_RUNS; i++) {
            codes.push((await runChild(body, { DOWNLOAD_URL: url })).code);
        }
        assert.deepStrictEqual(codes, Array(FETCH_RUNS).fill(7), 'every run should exit with the code, not abort (0xC0000409 = 3221226505)');
    } finally {
        server.close();
    }
    console.log(`✓ right after a fetch() download: exit 7 in all ${FETCH_RUNS} runs`);
}

async function main() {
    await testExitsOnItsOwn();
    await testHandleKeepsItAliveUntilGraceEnds();
    await testFirstCallWins();
    await testStdoutIsFlushed();
    await testExitRightAfterFetch();
}

runIfMain(import.meta.url, main);
