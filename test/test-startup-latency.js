/**
 * Pins down that the server answers `initialize` quickly enough that a
 * client is not at risk, by timing a real dist/index.js over stdio. The
 * reporter of #715 saw 25-90s; startup here was under a second even before.
 */

import assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.js');

const RUNS = 5;
const CEILING_MULTIPLE = 13;
const CEILING_FLOOR_MS = 400;
const RUN_TIMEOUT_MS = 120000;

/** A pristine home per run, so no measurement reads or disturbs the real config. */
function freshHome() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dc-startup-latency-'));
    const configDir = path.join(home, '.claude-server-commander');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ telemetryEnabled: false }));
    return home;
}

function bareNodeSpawnMs(samples = 5) {
    const timings = [];
    for (let i = 0; i < samples; i++) {
        const started = process.hrtime.bigint();
        spawnSync(process.execPath, ['-e', '0']);
        timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return median(timings);
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Timed to the first tool result as well. Measured, that does not catch a heavy
 * module loaded by the warm-up in between — case 4 of test-lazy-heavy-imports
 * does — but it keeps the first call a client makes inside the window.
 */
function measureOneStart() {
    return new Promise((resolve) => {
        const home = freshHome();
        const started = process.hrtime.bigint();
        const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;

        const child = spawn(process.execPath, [DIST_INDEX], {
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
                DC_FLAG_URL: 'http://127.0.0.1:1/flags',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let initializeMs = null;
        let settled = false;

        const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutHandle);
            child.once('exit', () => {
                try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
                resolve(result);
            });
            child.kill('SIGTERM');
        };

        const timeoutHandle = setTimeout(
            () => finish({ error: `no tool result within ${RUN_TIMEOUT_MS}ms`, initializeMs }),
            RUN_TIMEOUT_MS
        );

        child.stdout.on('data', (chunk) => {
            stdoutBuf += chunk.toString();
            let newlineIdx;
            while ((newlineIdx = stdoutBuf.indexOf('\n')) >= 0) {
                const line = stdoutBuf.slice(0, newlineIdx);
                stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue; // stray non-protocol output
                }
                if (msg.id === 1) {
                    initializeMs = elapsed();
                    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_config', arguments: {} } });
                } else if (msg.id === 2) {
                    finish({ initializeMs, firstToolMs: elapsed() });
                }
            }
        });

        child.on('error', (err) => finish({ error: err.message, initializeMs }));
        child.on('exit', (code) => {
            if (!settled) finish({ error: `server exited early with code ${code}`, initializeMs });
        });

        send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'dc-startup-latency-test', version: '1.0.0' },
            },
        });
    });
}

let passed = 0;
const EXPECTED_CASES = 2;
const ok = (msg) => { passed++; console.log(`✓ ${msg}`); };

async function run() {
    assert.ok(existsSync(DIST_INDEX), `${DIST_INDEX} not found — run npm run build first`);

    const bareMs = bareNodeSpawnMs();
    const ceilingMs = Math.max(CEILING_FLOOR_MS, bareMs * CEILING_MULTIPLE);
    console.log(`bare node spawn: ${bareMs.toFixed(0)}ms — ceiling ${ceilingMs.toFixed(0)}ms (${CEILING_MULTIPLE}x)`);

    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        const result = await measureOneStart();
        assert.ok(!result.error, `start ${i + 1} failed: ${result.error}`);
        runs.push(result);
        // First run is cold: nothing of this build is in the OS file cache yet.
        const label = i === 0 ? 'cold' : `warm ${i}`;
        console.log(`  ${label.padEnd(7)} initialize ${result.initializeMs.toFixed(0)}ms, first tool ${result.firstToolMs.toFixed(0)}ms`);
    }

    const initializeMedian = median(runs.map((r) => r.initializeMs));
    const firstToolMedian = median(runs.map((r) => r.firstToolMs));

    assert.ok(
        initializeMedian <= ceilingMs,
        `initialize took ${initializeMedian.toFixed(0)}ms (median of ${RUNS}), ceiling ${ceilingMs.toFixed(0)}ms — something heavy is back in the startup path`
    );
    ok(`initialize answers in ${initializeMedian.toFixed(0)}ms median, under the ${ceilingMs.toFixed(0)}ms ceiling`);

    // Keeps the first call a client makes inside the window.
    assert.ok(
        firstToolMedian <= ceilingMs * 1.2,
        `the first tool result took ${firstToolMedian.toFixed(0)}ms (median of ${RUNS}), ceiling ${(ceilingMs * 1.2).toFixed(0)}ms — the first call a client makes is outside the window`
    );
    ok(`the first tool result arrives in ${firstToolMedian.toFixed(0)}ms median, under the ${(ceilingMs * 1.2).toFixed(0)}ms ceiling`);
}

run()
    .then(() => {
        assert.strictEqual(passed, EXPECTED_CASES, `expected ${EXPECTED_CASES} cases, got ${passed}`);
        console.log(`\nPASS (${passed}/${EXPECTED_CASES})`);
        process.exit(0);
    })
    .catch((e) => { console.error(`\nFAIL: ${e.message}`); process.exit(1); });
