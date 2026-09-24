#!/usr/bin/env node

/**
 * Regression test: write_pdf ignores the few md-to-pdf options that would let
 * the caller or the markdown write the PDF somewhere else, run a different
 * program as the renderer, pass it their own flags, or hang it - whether the
 * option comes from write_pdf's `options` or from the markdown's front matter,
 * and even when front matter tries to re-add one. The render still succeeds,
 * the PDF is written only to the requested path, and the tool result names
 * every ignored option and why.
 *
 * Every other md-to-pdf option (stylesheet, script, page scripts, page
 * network, ...) is left to behave as md-to-pdf normally does; this test does
 * not exercise those.
 *
 * Each render is watched from outside so a case can prove Chrome ran on
 * Desktop Commander's own profile and that nothing is left running afterwards.
 *
 * Cases (each fails on code that honours the option):
 *   - front matter `dest` outside the allowed directories: no file there, the
 *     PDF is written to the requested path, the tool reports dest ignored
 *   - front matter `dest: stdout`: nothing written to stdout
 *   - `pdf_options.path` from the front matter and from `options`: no file there
 *   - front matter `devtools: true`: returns promptly, nothing left running
 *   - `launch_options.executablePath` (a path that would fail to launch) and
 *     `launch_options.args` (a rival --user-data-dir): render still succeeds on
 *     Desktop Commander's own Chrome and profile; the answer is the same as
 *     before, and the result's internal structuredContent names dest,
 *     pdf_options.path, launch_options.executablePath, launch_options.args and devtools
 *   - an image given by its absolute path (the served folder is a drive root,
 *     as when Desktop Commander runs from "/"): still served to the page
 */

import assert from 'assert';
import { channel } from 'diagnostics_channel';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { configManager } from '../dist/config-manager.js';
import { writePdf } from '../dist/tools/filesystem.js';
import { handleWritePdf } from '../dist/handlers/filesystem-handlers.js';
import { parsePdfToMarkdown } from '../dist/tools/pdf/index.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

/** Longest a Chrome profile may take to disappear after a render */
const PROFILE_REMOVAL_LIMIT_MS = 30_000;
/** Longest a render may take here before it counts as hanging (a safety net, not a tested behavior) */
const RENDER_GUARD_MS = 120_000;
const DC_PROFILE_PREFIX = 'desktop-commander-chrome-profile-';
const SECRET_FILE = 'secret.txt';
const SECRET = 'only the render may read this';
const IMAGE_FILE = 'dot.png';
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Chrome, Puppeteer and Desktop Commander put their temporary files in this
// test's own temp folder. Only `allowed` is an allowed directory.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-pdf-render-options-'));
process.env.TEMP = tempDir;
process.env.TMP = tempDir;
process.env.TMPDIR = tempDir;
const allowedDir = path.join(tempDir, 'allowed');
const outsideDir = path.join(tempDir, 'outside');
const servedDir = path.join(allowedDir, 'served');
fs.mkdirSync(servedDir, { recursive: true });
fs.mkdirSync(outsideDir);
fs.writeFileSync(path.join(servedDir, SECRET_FILE), SECRET);
fs.writeFileSync(path.join(servedDir, IMAGE_FILE), Buffer.from(ONE_PIXEL_PNG, 'base64'));
const originalCwd = process.cwd();

const unhandled = [];
process.on('unhandledRejection', (reason) => {
    unhandled.push(reason);
    console.error('✗ unhandled rejection:', reason);
});

const serverListening = channel('tracing:net.server.listen:asyncEnd');
const childProcessCreated = channel('child_process');
const allServers = [];
const allChromes = [];

/** Records the web servers a render opens, the requests they answer, and the Chrome it starts */
function watchRender() {
    const servers = [];
    const responses = [];
    const chromes = [];
    const listen = ({ server }) => {
        if (!(server instanceof http.Server)) return;
        servers.push(server);
        allServers.push(server);
    };
    const respond = ({ server, request, response }) => {
        if (servers.includes(server)) responses.push({ url: request.url, status: response.statusCode });
    };
    const serverResponded = channel('http.server.response.finish');
    const child = ({ process: created }) => {
        // The channel announces a child before spawning it; its arguments are set in the same tick
        queueMicrotask(() => {
            if (created.spawnargs?.some((arg) => arg.startsWith('--remote-debugging-'))) {
                chromes.push(created);
                allChromes.push(created);
            }
        });
    };
    serverListening.subscribe(listen);
    serverResponded.subscribe(respond);
    childProcessCreated.subscribe(child);
    return {
        servers,
        responses,
        chromes,
        stop: () => {
            serverListening.unsubscribe(listen);
            serverResponded.unsubscribe(respond);
            childProcessCreated.unsubscribe(child);
        },
    };
}

const isRunning = (child) => child.exitCode === null && child.signalCode === null;
const userDataDirsOf = (child) => child.spawnargs.filter((arg) => arg.startsWith('--user-data-dir=')).map((arg) => arg.slice('--user-data-dir='.length));

/** Settles with the render's result, or rejects if it runs longer than RENDER_GUARD_MS */
function guarded(promise, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: still rendering after ${RENDER_GUARD_MS}ms`)), RENDER_GUARD_MS);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Runs a render while watching it; resolves with what it opened, its return value, how long it took, and the error it rejected with, if any */
async function watched(label, run) {
    const render = watchRender();
    const started = Date.now();
    let value;
    let error;
    try {
        value = await guarded(run(), label);
    } catch (caught) {
        error = caught;
    } finally {
        render.stop();
    }
    return { ...render, value, error, ms: Date.now() - started };
}

/** When a render has settled: its servers are closed, its Chrome has exited, and its profile goes away */
async function assertNothingLeft(render, label) {
    assert.ok(render.chromes.length > 0, `${label}: the render should have started Chrome`);
    assert.deepStrictEqual(render.servers.filter((server) => server.listening).length, 0,
        `${label}: the render's web server is still listening after it settled`);
    const running = render.chromes.filter(isRunning).map((child) => child.pid);
    assert.deepStrictEqual(running, [], `${label}: Chrome (pid ${running.join(', ')}) still running after the render settled`);
    const profiles = render.chromes.flatMap(userDataDirsOf);
    const started = Date.now();
    while (profiles.some((dir) => fs.existsSync(dir)) && Date.now() - started < PROFILE_REMOVAL_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.deepStrictEqual(profiles.filter((dir) => fs.existsSync(dir)), [], `${label}: Chrome profile left behind`);
    assert.deepStrictEqual(unhandled.map((reason) => String(reason?.message ?? reason)), [], `${label}: unhandled rejection`);
}

/** Text of every page of a PDF, as the product's parser reads it back */
async function pdfText(file) {
    return (await parsePdfToMarkdown(file)).pages.map((page) => page.text).join('\n');
}

async function testFrontMatterDestOutsideAllowedDirs() {
    const outFile = path.join(allowedDir, 'dest.pdf');
    const copy = path.join(outsideDir, 'dest-copy.pdf');
    const markdown = `---\ndest: ${JSON.stringify(copy)}\n---\n# Front matter dest\n`;
    const result = await watched('dest', () => writePdf(outFile, markdown));
    if (result.error) throw result.error;
    assert.ok(fs.statSync(outFile).size > 0, 'the PDF should be written to the requested path');
    assert.strictEqual(fs.existsSync(copy), false, `front matter dest wrote a PDF outside the allowed directories: ${copy}`);
    assert.deepStrictEqual(result.value.map((o) => o.option), ['dest'], 'writePdf should report dest ignored');
    await assertNothingLeft(result, 'dest');
    console.log('✓ front matter dest: PDF written to the requested path only, reported ignored');
}

async function testFrontMatterDestStdout() {
    const outFile = path.join(allowedDir, 'dest-stdout.pdf');
    const written = [];
    const write = process.stdout.write;
    // Everything the render writes to stdout (which is the MCP connection in the server)
    process.stdout.write = (chunk, ...rest) => {
        written.push(Buffer.from(chunk));
        return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true;
    };
    let result;
    try {
        result = await watched('dest: stdout', () => writePdf(outFile, '---\ndest: stdout\n---\n# Front matter dest stdout\n'));
    } finally {
        process.stdout.write = write;
    }
    if (result.error) throw result.error;
    assert.ok(fs.statSync(outFile).size > 0, 'the PDF should be written to the requested path');
    assert.deepStrictEqual(written.map(String).filter((text) => text.includes('%PDF')).length, 0,
        `the render wrote the PDF to stdout (${Buffer.concat(written).length} bytes)`);
    await assertNothingLeft(result, 'dest: stdout');
    console.log('✓ front matter dest: stdout: nothing written to stdout');
}

async function testPdfOptionsPath() {
    const outFile = path.join(allowedDir, 'pdf-options-path.pdf');
    const fromFrontMatter = path.join(outsideDir, 'front-matter-path.pdf');
    const fromOptions = path.join(outsideDir, 'options-path.pdf');
    const markdown = `---\npdf_options:\n  path: ${JSON.stringify(fromFrontMatter)}\n---\n# pdf_options.path\n`;
    let result = await watched('pdf_options.path (front matter)', () => writePdf(outFile, markdown));
    if (result.error) throw result.error;
    assert.deepStrictEqual(result.value.map((o) => o.option), ['pdf_options.path'], 'front matter pdf_options.path should be reported ignored');
    await assertNothingLeft(result, 'pdf_options.path (front matter)');
    result = await watched('pdf_options.path (options)', () => writePdf(outFile, '# pdf_options.path', undefined, { pdf_options: { path: fromOptions } }));
    if (result.error) throw result.error;
    assert.deepStrictEqual(result.value.map((o) => o.option), ['pdf_options.path'], 'options pdf_options.path should be reported ignored');
    await assertNothingLeft(result, 'pdf_options.path (options)');
    assert.ok(fs.statSync(outFile).size > 0, 'the PDF should be written to the requested path');
    assert.deepStrictEqual([fromFrontMatter, fromOptions].filter((file) => fs.existsSync(file)), [],
        'pdf_options.path wrote a PDF outside the allowed directories');
    console.log('✓ pdf_options.path from front matter and from options: ignored');
}

async function testDevtoolsReturnsPromptly() {
    const outFile = path.join(allowedDir, 'devtools.pdf');
    const result = await watched('devtools', () => writePdf(outFile, '---\ndevtools: true\n---\n# Devtools\n'));
    if (result.error) throw result.error;
    assert.ok(fs.statSync(outFile).size > 0, 'the PDF should be written');
    assert.deepStrictEqual(result.value.map((o) => o.option), ['devtools'], 'devtools should be reported ignored');
    await assertNothingLeft(result, 'devtools');
    console.log(`✓ front matter devtools: true: ignored, returned after ${result.ms}ms`);
}

async function testIgnoredOptionsReportedInResult() {
    const outFile = path.join(allowedDir, 'ignored-reported.pdf');
    const destCopy = path.join(outsideDir, 'reported-dest.pdf');
    const pdfPath = path.join(outsideDir, 'reported-pdf-path.pdf');
    const rivalProfile = path.join(outsideDir, 'rival-profile');
    // dest from front matter; the rest from options
    const markdown = `---\ndest: ${JSON.stringify(destCopy)}\n---\n# Reported\n`;
    const options = {
        pdf_options: { path: pdfPath },
        // A browser that could never launch, and a rival profile: both must be ignored
        launch_options: { executablePath: path.join(outsideDir, 'not-a-real-chrome'), args: [`--user-data-dir=${rivalProfile}`] },
        devtools: true,
    };
    const result = await watched('reported', () => handleWritePdf({ path: outFile, content: markdown, options }));
    if (result.error) throw result.error;
    const response = result.value;
    assert.ok(!response.isError, `write_pdf should succeed even though options were ignored: ${JSON.stringify(response.content)}`);
    assert.ok(fs.statSync(outFile).size > 0, 'the PDF should be written to the requested path');

    // executablePath ignored: the render succeeded on Desktop Commander's Chrome, not the bogus path
    assert.ok(result.chromes.length > 0, 'Desktop Commander should have launched its own Chrome');
    // args ignored: Chrome ran on Desktop Commander's own profile only, never the rival one
    const profiles = result.chromes.flatMap(userDataDirsOf);
    assert.ok(profiles.length > 0 && profiles.every((dir) => path.basename(dir).startsWith(DC_PROFILE_PREFIX)),
        `Chrome should run on Desktop Commander's profile only, saw: ${profiles.join(', ')}`);
    assert.strictEqual(profiles.includes(rivalProfile), false, 'launch_options.args added a rival --user-data-dir');

    // Nothing was written outside the allowed directory
    assert.deepStrictEqual([destCopy, pdfPath].filter((file) => fs.existsSync(file)), [], 'an ignored option still wrote a file outside the allowed directories');

    // The answer is the same as before; which options were ignored, and why, is kept internally
    const text = response.content?.find((block) => block.type === 'text')?.text ?? '';
    assert.strictEqual(text, `Successfully wrote PDF to ${outFile}`, 'the answer should be the same as before');
    const expected = ['dest', 'pdf_options.path', 'launch_options.executablePath', 'launch_options.args', 'devtools'];
    const reported = response.structuredContent?.ignoredOptions ?? [];
    assert.deepStrictEqual(reported.map((o) => o.option).sort(), [...expected].sort(),
        `structuredContent.ignoredOptions should name exactly the ignored options: ${JSON.stringify(reported)}`);
    assert.ok(reported.every((o) => typeof o.reason === 'string' && o.reason.length > 0), 'each ignored option should carry a reason');

    await assertNothingLeft(result, 'reported');
    console.log('✓ ignored options: render still succeeded on our Chrome/profile, the answer is unchanged, all named internally');
}

async function testImageByAbsolutePath() {
    const outFile = path.join(allowedDir, 'absolute-image.pdf');
    const root = path.parse(servedDir).root;
    const imageUrl = '/' + path.relative(root, path.join(servedDir, IMAGE_FILE)).split(path.sep).map(encodeURIComponent).join('/');
    // Desktop Commander serves its working folder: "/" when a client starts it there
    process.chdir(root);
    let result;
    try {
        result = await watched('absolute image', () => writePdf(outFile, `# Absolute image\n\n![dot](${imageUrl})`));
    } finally {
        process.chdir(servedDir);
    }
    if (result.error) throw result.error;
    assert.deepStrictEqual(result.responses.filter(({ url }) => url === imageUrl), [{ url: imageUrl, status: 200 }],
        'the image given by its absolute path should be served to the page');
    await assertNothingLeft(result, 'absolute image');
    console.log('✓ image by absolute path: served to the page');
}

async function main() {
    const originalAllowed = (await configManager.getConfig()).allowedDirectories;
    await configManager.setValue('allowedDirectories', [allowedDir]);
    process.chdir(servedDir);
    const cases = [
        testFrontMatterDestOutsideAllowedDirs,
        testFrontMatterDestStdout,
        testPdfOptionsPath,
        testDevtoolsReturnsPromptly,
        testIgnoredOptionsReportedInResult,
        testImageByAbsolutePath,
    ];
    const failures = [];
    let noChrome;
    try {
        for (const test of cases) {
            try {
                await test();
            } catch (error) {
                if (/requires Chrome or Chromium/.test(error.message)) {
                    noChrome = error;
                    break;
                }
                failures.push(error);
                console.error(`✗ ${error.message}`);
            }
        }
    } finally {
        process.chdir(originalCwd);
        await configManager.setValue('allowedDirectories', originalAllowed ?? []);
        // Whatever a failing case left open: servers still listening, Chrome still running
        for (const server of allServers) {
            server.closeAllConnections?.();
            server.close();
        }
        for (const child of allChromes.filter(isRunning)) {
            child.kill();
        }
        const removeBy = Date.now() + PROFILE_REMOVAL_LIMIT_MS;
        for (;;) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
                break;
            } catch (error) {
                if (Date.now() >= removeBy) {
                    console.error(`Could not remove ${tempDir}: ${error.message}`);
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
    }
    // Failures before Chrome went missing still fail the file; only then is it a skip
    if (failures.length > 0) {
        throw new Error(`${failures.length} of ${cases.length} cases failed`);
    }
    if (noChrome) {
        skip(`PDF render options: no Chrome to launch (${noChrome.message})`);
    }
}

runIfMain(import.meta.url, main);
