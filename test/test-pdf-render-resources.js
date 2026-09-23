#!/usr/bin/env node

/**
 * Regression test: a PDF render releases everything it opens, on every path,
 * and its local web server serves nobody but the render's own Chrome.
 *
 * md-to-pdf serves the markdown's base folder (Desktop Commander's working
 * folder) over HTTP while Chrome renders, so relative and absolute image paths
 * load. mdToPdf() started that server and then Chrome, and stopped them only
 * after a successful render: after a failed Chrome launch the server kept
 * listening until Desktop Commander restarted, and after a conversion that
 * failed once Chrome was running, Chrome kept running too. The server listened
 * on every network interface and answered anyone who asked.
 *
 * Every render is watched from outside: the HTTP servers it opens (Node's
 * net.server.listen tracing channel), the requests they answer
 * (http.server.response.finish) and the Chrome it starts (Node's
 * child_process channel). The served folder is this test's own, with an
 * image the markdown shows and a file no one but the render may read.
 *
 * Cases:
 *   - a successful render: its server listens on 127.0.0.1 only, refuses a
 *     request that does not come from its Chrome while serving that Chrome
 *     the image, and when writePdf returns, the server is closed, Chrome has
 *     exited, and its profile is removed
 *   - a Chrome launch that fails (launch_options.timeout = 1): the same when writePdf rejects
 *   - a conversion that fails after Chrome launched (a stylesheet that does not exist): the same
 *   - launch_options.args carrying a rival --user-data-dir: it is ignored, so
 *     Chrome still runs on Desktop Commander's own profile and nothing is left
 *     behind (Desktop Commander always launches Chrome on its own profile via
 *     args, so a caller cannot move it off, which is what closed #22/#31)
 */

import assert from 'assert';
import { channel } from 'diagnostics_channel';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

import { writePdf } from '../dist/tools/filesystem.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

/** Longest a Chrome profile may take to disappear after a render */
const PROFILE_REMOVAL_LIMIT_MS = 30_000;
const LAUNCH_TIMEOUT_MESSAGE = 'Timed out after 1 ms while waiting for the WS endpoint URL to appear in stdout!';
const DC_PROFILE_PREFIX = 'desktop-commander-chrome-profile-';
/** Puppeteer prefixes a temporary profile folder it creates itself with puppeteer_dev_chrome_profile- */
const PUPPETEER_PROFILE_MARKER = 'puppeteer_dev_chrome_profile-';
const SECRET_FILE = 'secret.txt';
const SECRET = 'only the render may read this';
/** An image in the served folder that the rendered markdown shows by its relative path */
const IMAGE_FILE = 'dot.png';
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Chrome, Puppeteer and Desktop Commander put their temporary files in this
// test's own temp folder; md-to-pdf serves the working folder
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-pdf-render-resources-'));
process.env.TEMP = tempDir;
process.env.TMP = tempDir;
process.env.TMPDIR = tempDir;
const servedDir = path.join(tempDir, 'served');
fs.mkdirSync(servedDir);
fs.writeFileSync(path.join(servedDir, SECRET_FILE), SECRET);
fs.writeFileSync(path.join(servedDir, IMAGE_FILE), Buffer.from(ONE_PIXEL_PNG, 'base64'));
const originalCwd = process.cwd();

// A late unhandled rejection is what took the server down after a failed launch
const unhandled = [];
process.on('unhandledRejection', (reason) => {
    unhandled.push(reason);
    console.error('✗ unhandled rejection:', reason);
});

const serverListening = channel('tracing:net.server.listen:asyncEnd');
const serverResponded = channel('http.server.response.finish');
const childProcessCreated = channel('child_process');
/** Everything any render opened, so a leak one case leaves can be closed at the end */
const allServers = [];
const allChromes = [];

/**
 * Records the web servers a render opens, the requests they answer, and the
 * Chrome processes it starts. As soon as a server listens, a client that is
 * not the render's Chrome asks it for the secret file.
 */
function watchRender() {
    const servers = [];
    const responses = [];
    const chromes = [];
    const onListen = ({ server }) => {
        // Plain net servers are not web servers (md-to-pdf's port finder listens briefly with one)
        if (!(server instanceof http.Server)) return;
        const { address, port } = server.address();
        const probe = get(port, `/${SECRET_FILE}`);
        servers.push({ server, address, port, probe });
        allServers.push(server);
    };
    const onResponse = ({ server, request, response }) => {
        if (servers.some((watched) => watched.server === server)) {
            responses.push({ url: request.url, status: response.statusCode });
        }
    };
    const onChild = ({ process: child }) => {
        // The channel announces a child before spawning it; its arguments are set in the same tick
        queueMicrotask(() => {
            if (child.spawnargs?.some((arg) => arg.startsWith('--remote-debugging-'))) {
                chromes.push(child);
                allChromes.push(child);
            }
        });
    };
    serverListening.subscribe(onListen);
    serverResponded.subscribe(onResponse);
    childProcessCreated.subscribe(onChild);
    return {
        servers,
        responses,
        chromes,
        stop: () => {
            serverListening.unsubscribe(onListen);
            serverResponded.unsubscribe(onResponse);
            childProcessCreated.unsubscribe(onChild);
        },
    };
}

/** GET from 127.0.0.1:port, as any local program could: resolves with the status and body, or the connection error */
function get(port, urlPath) {
    return new Promise((resolve) => {
        const request = http.get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        request.on('error', (error) => resolve({ error: error.code ?? error.message }));
        request.setTimeout(5000, () => request.destroy(new Error('no answer within 5s')));
    });
}

/** Resolves true if something accepts a connection on 127.0.0.1:port */
function acceptsConnections(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.setTimeout(5000, () => { socket.destroy(); resolve(true); });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
    });
}

const isRunning = (child) => child.exitCode === null && child.signalCode === null;
const userDataDirOf = (child) => child.spawnargs.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);

/**
 * Checks what a render has left the moment writePdf settled: its servers must
 * be closed and its Chrome must have exited. Then waits for its Chrome
 * profile to be removed (that happens in the background once Chrome is gone).
 */
async function assertNothingLeft(render, label) {
    assert.ok(render.servers.length > 0, `${label}: the render should have opened its web server`);
    for (const { server, port } of render.servers) {
        const stillListening = server.listening;
        const stillAccepting = await acceptsConnections(port);
        assert.ok(!stillListening && !stillAccepting,
            `${label}: the render's web server on port ${port} is still ${stillListening ? 'listening' : 'accepting connections'} after writePdf settled`);
    }
    assert.ok(render.chromes.length > 0, `${label}: the render should have started Chrome`);
    const running = render.chromes.filter(isRunning).map((child) => child.pid);
    assert.deepStrictEqual(running, [], `${label}: Chrome (pid ${running.join(', ')}) still running after writePdf settled`);

    const profiles = render.chromes.map(userDataDirOf);
    const started = Date.now();
    while (profiles.some((dir) => fs.existsSync(dir)) && Date.now() - started < PROFILE_REMOVAL_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const left = profiles.filter((dir) => fs.existsSync(dir));
    assert.deepStrictEqual(left, [], `${label}: Chrome profile left ${Date.now() - started}ms after writePdf settled`);
    assert.deepStrictEqual(unhandled.map((reason) => String(reason?.message ?? reason)), [],
        `${label}: unhandled rejection (src/index.ts exits the server on these)`);
    return Date.now() - started;
}

/** Runs writePdf while watching the render; resolves with what it opened and the error it rejected with, if any */
async function render(outFile, markdown, options) {
    const watched = watchRender();
    let error;
    try {
        await writePdf(outFile, markdown, undefined, options);
    } catch (caught) {
        error = caught;
    } finally {
        watched.stop();
    }
    return { ...watched, error };
}

async function testSuccessfulRender() {
    const outFile = path.join(tempDir, 'rendered.pdf');
    const result = await render(outFile, `# Rendered\n\nEverything worked.\n\n![dot](${IMAGE_FILE})`);
    if (result.error) throw result.error;
    assert.ok(fs.statSync(outFile).size > 0, 'the rendered PDF should not be empty');

    assert.strictEqual(result.servers.length, 1, 'one web server per render');
    const [{ address, probe }] = result.servers;
    assert.deepStrictEqual(await probe, { status: 403, body: 'Forbidden' },
        'a client other than the render\'s Chrome should be refused, not handed files from the served folder');
    assert.strictEqual(address, '127.0.0.1', 'the render\'s web server should listen on the loopback interface only');
    // The render's Chrome still gets what it asks for, e.g. the markdown's image
    const chromeResponses = result.responses.filter(({ url }) => url !== `/${SECRET_FILE}`);
    assert.deepStrictEqual(chromeResponses.filter(({ url }) => url === `/${IMAGE_FILE}`), [{ url: `/${IMAGE_FILE}`, status: 200 }],
        'the render\'s Chrome should be served the markdown\'s image from the served folder');
    assert.deepStrictEqual(chromeResponses.filter(({ status }) => status === 403), [],
        'no request from the render\'s Chrome should be refused');

    const waited = await assertNothingLeft(result, 'successful render');
    console.log(`✓ successful render: served on 127.0.0.1 to its Chrome only, server closed and Chrome gone on return, profile removed after ${waited}ms`);
}

async function testFailedLaunch() {
    const outFile = path.join(tempDir, 'launch-failed.pdf');
    const result = await render(outFile, '# Never rendered', { launch_options: { timeout: 1 } });
    assert.strictEqual(result.error?.message, LAUNCH_TIMEOUT_MESSAGE, 'writePdf should reject with the launch error');
    assert.strictEqual(fs.existsSync(outFile), false, 'no PDF should be written when the launch fails');

    const waited = await assertNothingLeft(result, 'failed launch');
    console.log(`✓ failed launch: rejected, server closed and Chrome gone on return, profile removed after ${waited}ms`);
}

async function testFailedConversion() {
    const outFile = path.join(tempDir, 'conversion-failed.pdf');
    // md-to-pdf adds the stylesheet once Chrome has opened the page: reading it fails
    const missingStylesheet = path.join(tempDir, 'missing.css');
    const result = await render(outFile, '# Never rendered', { stylesheet: [missingStylesheet] });
    assert.strictEqual(result.error?.message, `ENOENT: no such file or directory, open '${missingStylesheet}'`,
        'writePdf should reject with the conversion error');
    assert.strictEqual(fs.existsSync(outFile), false, 'no PDF should be written when the conversion fails');
    assert.ok(result.chromes.length > 0 && result.chromes.every((child) => child.pid !== undefined),
        'Chrome should have launched before the conversion failed');

    const waited = await assertNothingLeft(result, 'failed conversion');
    console.log(`✓ conversion failing after launch: rejected, server closed and Chrome gone on return, profile removed after ${waited}ms`);
}

async function testCallerArgsCannotChangeProfile() {
    const outFile = path.join(tempDir, 'caller-args.pdf');
    const rivalProfile = path.join(tempDir, 'rival-profile');
    // launch_options.args is ignored, so a caller cannot point Chrome at its own
    // profile; the render succeeds on Desktop Commander's own profile (headless,
    // the default: no window on the desktop running the test)
    const result = await render(outFile, '# Rendered', { launch_options: { args: [`--user-data-dir=${rivalProfile}`] } });
    if (result.error) throw result.error;
    assert.ok(fs.statSync(outFile).size > 0, 'the rendered PDF should not be empty');

    const profiles = result.chromes.map(userDataDirOf);
    assert.ok(profiles.length > 0 && profiles.every((dir) => dir && path.basename(dir).startsWith(DC_PROFILE_PREFIX)),
        `Chrome should run on Desktop Commander's profile folder, not the caller's (${PUPPETEER_PROFILE_MARKER}* or the rival): ${profiles.join(', ')}`);
    assert.strictEqual(profiles.includes(rivalProfile), false, 'launch_options.args set a rival --user-data-dir');

    const waited = await assertNothingLeft(result, 'launch_options.args ignored');
    console.log(`✓ launch_options.args ignored: Chrome ran on Desktop Commander's profile, nothing left, profile removed after ${waited}ms`);
}

async function main() {
    // md-to-pdf serves the working folder unless told otherwise
    process.chdir(servedDir);
    const failures = [];
    try {
        try {
            await testSuccessfulRender();
        } catch (error) {
            if (/requires Chrome or Chromium/.test(error.message)) {
                skip(`PDF render resources: no Chrome to launch (${error.message})`);
                return;
            }
            failures.push(error);
            console.error(`✗ ${error.message}`);
        }
        for (const test of [testFailedLaunch, testFailedConversion, testCallerArgsCannotChangeProfile]) {
            try {
                await test();
            } catch (error) {
                failures.push(error);
                console.error(`✗ ${error.message}`);
            }
        }
    } finally {
        process.chdir(originalCwd);
        // Whatever a failing case left open: servers still listening, Chrome still running
        for (const server of allServers) {
            server.closeAllConnections?.();
            server.close();
        }
        for (const child of allChromes.filter(isRunning)) {
            child.kill();
        }
        // Chrome's helper processes can hold the folder a moment longer than the browser process
        const removeBy = Date.now() + PROFILE_REMOVAL_LIMIT_MS;
        for (;;) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
                break;
            } catch (error) {
                if (Date.now() >= removeBy) {
                    // Reported, not thrown: it would replace the assertion that explains why
                    console.error(`Could not remove ${tempDir}: ${error.message}`);
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
    }
    if (failures.length > 0) {
        throw new Error(`${failures.length} of 4 cases failed`);
    }
}

runIfMain(import.meta.url, main);
