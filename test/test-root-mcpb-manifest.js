import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '@anthropic-ai/mcpb/node';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('repository root contains a stable, valid MCPB manifest snapshot', () => {
    const manifest = json(path.join(root, 'manifest.json'));
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.name, 'desktop-commander');
    assert.equal(manifest.manifest_version, '0.3');
    assert.equal(manifest.server.type, 'node');
    assert.equal(manifest.server.entry_point, 'dist/index.js');
    // The template's build-relative schema path does not resolve at repo root.
    assert.equal(Object.hasOwn(manifest, '$schema'), false);

    // Anthropic's own published MCPB schema and icon validation.
    assert.equal(validateManifest(path.join(root, 'manifest.json')), true);

    // Keep the root copy byte-for-byte semantically aligned with the only
    // metadata source of truth; no edits to descriptions, tools or commands.
    const expected = JSON.parse(
        readFileSync(path.join(root, 'manifest.template.json'), 'utf8')
            .replace('"{{VERSION}}"', JSON.stringify(manifest.version))
    );
    delete expected.$schema;
    assert.deepEqual(manifest, expected);
});

test('version sync keeps alpha private and refreshes root manifest for stable releases', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dc-root-manifest-'));
    const template = readFileSync(path.join(root, 'manifest.template.json'), 'utf8');
    const stable = json(path.join(root, 'manifest.json'));

    try {
        mkdirSync(path.join(tmp, 'src'));
        writeFileSync(path.join(tmp, 'manifest.template.json'), template);
        writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(stable, null, 2) + '\n');
        writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '0.3.2-alpha.1' }));
        writeFileSync(path.join(tmp, 'server.json'), JSON.stringify({
            version: '0.3.1',
            packages: [{ registryType: 'npm', identifier: '@wonderwhy-er/desktop-commander', version: '0.3.1' }]
        }));

        const runSync = () => execFileSync(
            process.execPath,
            [path.join(root, 'scripts', 'sync-version.js')],
            { cwd: tmp, stdio: 'pipe' }
        );

        runSync();
        assert.deepEqual(json(path.join(tmp, 'manifest.json')), stable);
        assert.equal(json(path.join(tmp, 'server.json')).version, '0.3.2-alpha.1');

        writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '0.3.2' }));
        runSync();

        const expected = JSON.parse(template.replace('"{{VERSION}}"', '"0.3.2"'));
        delete expected.$schema;
        assert.deepEqual(json(path.join(tmp, 'manifest.json')), expected);
        assert.equal(json(path.join(tmp, 'server.json')).version, '0.3.2');
        assert.equal(json(path.join(tmp, 'server.json')).packages[0].version, '0.3.2');
        assert.equal(readFileSync(path.join(tmp, 'src/version.ts'), 'utf8'),
            "export const VERSION = '0.3.2';\n");
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
