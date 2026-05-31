#!/usr/bin/env node

/**
 * Test Chrome for Testing cache pruning used by PDF generation.
 */

import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    findPuppeteerChrome,
    pruneOldPuppeteerChromeBuilds,
} from '../dist/tools/pdf/markdown.js';

function executablePathForBuild(chromeDir, buildDirName) {
    if (process.platform === 'win32') {
        return path.join(chromeDir, buildDirName, 'chrome-win64', 'chrome.exe');
    }

    if (process.platform === 'darwin') {
        return path.join(
            chromeDir,
            buildDirName,
            'chrome-mac-arm64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing',
        );
    }

    return path.join(chromeDir, buildDirName, 'chrome-linux64', 'chrome');
}

async function createChromeBuild(chromeDir, buildDirName) {
    const executablePath = executablePathForBuild(chromeDir, buildDirName);
    await fs.mkdir(path.dirname(executablePath), { recursive: true });
    await fs.writeFile(executablePath, '');
    return executablePath;
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-chrome-cache-'));

    try {
        const cacheDir = path.join(tempRoot, 'puppeteer');
        const chromeDir = path.join(cacheDir, 'chrome');
        const oldBuildDir = path.join(chromeDir, 'mac_arm-148.0.7778.56');
        const activeBuildDir = path.join(chromeDir, 'mac_arm-149.0.7827.54');

        const oldExecutablePath = await createChromeBuild(chromeDir, path.basename(oldBuildDir));
        const activeExecutablePath = await createChromeBuild(chromeDir, path.basename(activeBuildDir));

        const foundChrome = findPuppeteerChrome(cacheDir);
        assert.strictEqual(
            foundChrome?.executablePath,
            activeExecutablePath,
            'newest cached Chrome build should be selected',
        );

        await pruneOldPuppeteerChromeBuilds(activeExecutablePath, cacheDir);

        assert.strictEqual(
            await pathExists(activeExecutablePath),
            true,
            'active Chrome executable should remain',
        );
        assert.strictEqual(
            await pathExists(oldExecutablePath),
            false,
            'old Chrome executable should be removed',
        );
        assert.strictEqual(
            await pathExists(oldBuildDir),
            false,
            'old Chrome build directory should be removed',
        );
    } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
    }

    console.log('Chrome cache pruning test passed');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
