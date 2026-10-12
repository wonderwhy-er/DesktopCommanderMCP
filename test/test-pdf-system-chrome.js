#!/usr/bin/env node

/**
 * An installed Chrome is found for PDF rendering wherever Windows keeps
 * programs. Windows is not always on C:, and its Program Files and local app
 * data folders can be elsewhere too; Windows says where they are in
 * ProgramFiles, ProgramW6432, ProgramFiles(x86) and LOCALAPPDATA. Chrome and
 * Chromium were looked for only under C:\Program Files and
 * C:\Program Files (x86) (and LOCALAPPDATA), so on such a machine an installed
 * Chrome went unused: rendering downloaded Chrome for Testing, or failed
 * without a network.
 *
 * Each case points one setting at a temporary folder holding a stand-in
 * chrome.exe where that browser installs, and the others at an empty folder.
 * Windows only.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findSystemChrome } from '../dist/tools/pdf/markdown.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const SETTINGS = ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA'];
const CHROME = ['Google', 'Chrome', 'Application', 'chrome.exe'];
const CHROMIUM = ['Chromium', 'Application', 'chrome.exe'];

/**
 * Runs `check(expected, folder)` with `setting` pointed at a folder holding a stand-in
 * at `subPath`, and the other SETTINGS at an empty folder; restores them all.
 */
function withStandIn(setting, subPath, check) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-system-chrome-'));
    const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
    try {
        const empty = path.join(root, 'empty');
        const folder = path.join(root, 'D-drive', setting.replace(/[()]/g, ''));
        const expected = path.join(folder, ...subPath);
        fs.mkdirSync(empty);
        fs.mkdirSync(path.dirname(expected), { recursive: true });
        fs.writeFileSync(expected, '');
        for (const name of SETTINGS) process.env[name] = empty;
        process.env[setting] = folder;
        check(expected, folder);
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function run() {
    if (process.platform !== 'win32') {
        return skip('Chrome in the folders Windows names (ProgramFiles, …): Windows only');
    }
    const failures = [];
    const cases = [
        ['ProgramFiles', CHROME, 'Chrome under Program Files'],
        ['ProgramFiles(x86)', CHROME, 'Chrome under Program Files (x86)'],
        ['ProgramW6432', CHROME, '64-bit Chrome seen from a 32-bit Node (ProgramW6432)'],
        ['LOCALAPPDATA', CHROME, 'Chrome installed for the user (LOCALAPPDATA)'],
        ['ProgramFiles', CHROMIUM, 'Chromium under Program Files'],
        ['ProgramFiles(x86)', CHROMIUM, 'Chromium under Program Files (x86)'],
    ];
    for (const [setting, subPath, what] of cases) {
        try {
            withStandIn(setting, subPath, (expected, folder) => {
                const found = findSystemChrome();
                assert.strictEqual(found, expected,
                    `${what}, with ${setting}=${folder}: PDF rendering found `
                    + `${found ?? 'no Chrome'} instead of the one installed there, so it downloads Chrome or fails offline`);
            });
            console.log(`✓ ${what} is found where ${setting} says, not only on C:`);
        } catch (error) {
            failures.push(what);
            console.log(`✗ ${error.message}`);
        }
    }

    // With the machine's own settings, the same browser as before: on the usual
    // layout, the one the fixed C: paths found
    const usualLayout = process.env.ProgramFiles === 'C:\\Program Files' && process.env['ProgramFiles(x86)'] === 'C:\\Program Files (x86)';
    if (usualLayout) {
        const before = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ].find((file) => fs.existsSync(file));
        try {
            assert.strictEqual(findSystemChrome(), before, 'with this machine\'s own settings, a different browser was found than before');
            console.log(`✓ with this machine's settings, the same browser as before: ${before ?? 'none installed'}`);
        } catch (error) {
            failures.push('the machine\'s own settings');
            console.log(`✗ ${error.message}`);
        }
    } else {
        skip('same browser as before with the machine\'s own settings: its Program Files folders are not the usual C: ones');
    }

    if (failures.length > 0) {
        console.log(`${failures.length} system Chrome check(s) failed`);
        return false;
    }
    return true;
}

runIfMain(import.meta.url, run);

export default run;
