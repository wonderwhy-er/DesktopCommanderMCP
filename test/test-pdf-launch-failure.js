#!/usr/bin/env node

/**
 * Regression test: a PDF render whose Chrome launch fails must not take the
 * MCP server down.
 *
 * Puppeteer used to create Chrome's profile folder itself and delete it when
 * the launch failed, about 5 seconds later and in a promise nobody awaited.
 * On Windows Chrome was still running and holding the folder, the delete
 * failed with EBUSY, and src/index.ts exits the server on any unhandled
 * rejection, so one failed write_pdf killed Desktop Commander about 16 seconds
 * after the tool call had already returned its error.
 *
 * The launch is made to fail with launch_options.timeout = 1: Puppeteer gives
 * up before Chrome prints its DevTools endpoint and Chrome keeps running, the
 * same state as a Chrome that never opens the endpoint (the Google Chrome 136+
 * remote-debugging refusal), without the 30 second wait.
 *
 * Cases:
 *   - a render that succeeds leaves no Chrome profile folder behind
 *   - a failed launch is returned as the caller's error, writes no file,
 *     raises no unhandled rejection, and its profile folder is removed once
 *     Chrome is gone
 */

import assert from 'assert';
import { channel } from 'diagnostics_channel';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { writePdf } from '../dist/tools/filesystem.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

/** Longest a Chrome profile may take to disappear after a render */
const PROFILE_REMOVAL_LIMIT_MS = 30_000;
const LAUNCH_TIMEOUT_MESSAGE = 'Timed out after 1 ms while waiting for the WS endpoint URL to appear in stdout!';
const USER_DATA_DIR_ARG = '--user-data-dir=';
/** Node announces every child process it creates on this channel */
const childProcessCreated = channel('child_process');

// Chrome, Puppeteer and Desktop Commander put their temporary files in this
// test's own temp folder, so the test can see exactly what a render leaves behind
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-pdf-launch-failure-'));
process.env.TEMP = tempDir;
process.env.TMP = tempDir;
process.env.TMPDIR = tempDir;

// A late unhandled rejection is exactly what this test guards against
const unhandled = [];
process.on('unhandledRejection', (reason) => {
    unhandled.push(reason);
    console.error('✗ unhandled rejection:', reason);
});

/**
 * Records the profile folders of the Chrome processes started while a render
 * is in progress, from their --user-data-dir argument: Desktop Commander's
 * own, or one Puppeteer created itself. (A Chrome stopped right after a
 * failed launch may not have written anything into its folder yet.)
 */
function watchChromeProfiles() {
    const seen = new Set();
    const onChild = ({ process: child }) => {
        // The channel announces a child before spawning it; its arguments are set in the same tick
        queueMicrotask(() => {
            const arg = child.spawnargs?.find((spawnarg) => spawnarg.startsWith(USER_DATA_DIR_ARG));
            if (arg) {
                seen.add(arg.slice(USER_DATA_DIR_ARG.length));
            }
        });
    };
    childProcessCreated.subscribe(onChild);
    return {
        seen,
        stop: () => childProcessCreated.unsubscribe(onChild),
        remaining: () => [...seen].filter((dir) => fs.existsSync(dir)),
    };
}

/** Waits until Chrome has run on a profile and it is gone again, an unhandled rejection arrives, or the limit passes */
async function waitForProfileRemoval(profiles) {
    const started = Date.now();
    while ((profiles.seen.size === 0 || profiles.remaining().length > 0) && unhandled.length === 0 && Date.now() - started < PROFILE_REMOVAL_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return Date.now() - started;
}

async function testSuccessfulRenderLeavesNoProfile() {
    const outFile = path.join(tempDir, 'rendered.pdf');
    const profiles = watchChromeProfiles();
    try {
        await writePdf(outFile, '# Rendered\n\nChrome launched fine.');
    } finally {
        profiles.stop();
    }
    assert.ok(fs.statSync(outFile).size > 0, 'the rendered PDF should not be empty');
    assert.strictEqual(profiles.seen.size, 1, `Chrome should have run on one profile folder, saw: ${[...profiles.seen]}`);

    const waited = await waitForProfileRemoval(profiles);
    assert.deepStrictEqual(profiles.remaining(), [], `Chrome profile left ${waited}ms after a successful render`);
    console.log(`✓ successful render: PDF written, Chrome profile gone after ${waited}ms`);
}

async function testFailedLaunchIsAnOrdinaryError() {
    const outFile = path.join(tempDir, 'never-written.pdf');
    const profiles = watchChromeProfiles();
    let error;
    try {
        await writePdf(outFile, '# Never rendered', undefined, { launch_options: { timeout: 1 } });
    } catch (caught) {
        error = caught;
    }

    assert.ok(error, 'writePdf should reject when Chrome cannot be launched');
    assert.strictEqual(error.message, LAUNCH_TIMEOUT_MESSAGE);
    assert.strictEqual(fs.existsSync(outFile), false, 'no PDF should be written when the launch fails');
    console.log(`✓ failed launch rejected with: ${error.message}`);

    // The profile is removed in the background once Chrome is gone
    const waited = await waitForProfileRemoval(profiles);
    profiles.stop();
    assert.deepStrictEqual(unhandled.map((reason) => String(reason?.message ?? reason)), [],
        `unhandled rejection ${waited}ms after the failed launch (src/index.ts exits the server on these)`);
    assert.strictEqual(profiles.seen.size, 1, `Chrome should have run on one profile folder, saw: ${[...profiles.seen]}`);
    assert.deepStrictEqual(profiles.remaining(), [], `Chrome profile left ${waited}ms after the failed launch`);
    console.log(`✓ failed launch: no unhandled rejection, Chrome profile gone after ${waited}ms`);
}

async function main() {
    try {
        try {
            await testSuccessfulRenderLeavesNoProfile();
        } catch (error) {
            if (/requires Chrome or Chromium/.test(error.message)) {
                skip(`PDF launch failure: no Chrome to launch (${error.message})`);
                return;
            }
            throw error;
        }
        await testFailedLaunchIsAnOrdinaryError();
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
        } catch (error) {
            // Reported, not thrown: it would replace the assertion that explains why
            console.error(`Could not remove ${tempDir}: ${error.message}`);
        }
    }
}

runIfMain(import.meta.url, main);
