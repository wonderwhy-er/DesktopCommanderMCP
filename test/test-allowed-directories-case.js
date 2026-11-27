/**
 * Regression test for #791: on a case-sensitive filesystem, a directory that
 * differs from an allowed directory only by letter case is a different
 * directory and must not pass the allowedDirectories check.
 */

import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';

async function differentlyCasedSiblingIsNotAllowed() {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-case-sensitive-'));
    const upperDir = path.join(base, 'DC-Allow');
    const lowerDir = path.join(base, 'dc-allow');

    try {
        await fs.mkdir(upperDir);
        try {
            await fs.mkdir(lowerDir);
        } catch (error) {
            if (error.code === 'EEXIST') return skip('filesystem is case-insensitive');
            throw error;
        }

        const [upperStat, lowerStat] = await Promise.all([fs.stat(upperDir), fs.stat(lowerDir)]);
        if (upperStat.ino === lowerStat.ino && upperStat.dev === lowerStat.dev) {
            return skip('filesystem is case-insensitive');
        }

        const allowedFile = path.join(upperDir, 'inside.txt');
        const otherFile = path.join(lowerDir, 'secret.txt');
        await fs.writeFile(allowedFile, 'allowed');
        await fs.writeFile(otherFile, 'secret');

        const before = await configManager.getConfig();
        const originalAllowedDirs = before.allowedDirectories;
        await configManager.setValue('allowedDirectories', [upperDir]);
        try {
            // The allowed directory and its contents still validate
            await validatePath(allowedFile);

            // The differently-cased sibling is a different directory here
            await assert.rejects(
                () => validatePath(otherFile),
                /Path not allowed/,
                'a differently-cased sibling directory must not be treated as allowed'
            );
        } finally {
            // Always restore, also when the original value is undefined or not
            // an array: setValue persists through JSON.stringify, which omits
            // an undefined property and so restores its absence.
            await configManager.setValue('allowedDirectories', originalAllowedDirs);
        }
    } finally {
        await fs.rm(base, { recursive: true, force: true });
    }
}

export default async function runTests() {
    const failures = [];
    for (const check of [differentlyCasedSiblingIsNotAllowed]) {
        try {
            console.log(`${(await check()) === SKIPPED ? '- skipped:' : '✓'} ${check.name}`);
        } catch (error) {
            failures.push(check.name);
            console.log(`✗ ${check.name}: ${error.message}`);
        }
    }
    return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
