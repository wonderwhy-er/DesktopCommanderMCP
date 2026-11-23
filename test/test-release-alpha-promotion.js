import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import releaseVersion from '../scripts/release-version.cjs';

const { nextStableVersion } = releaseVersion;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (filename) => JSON.parse(readFileSync(filename, 'utf8'));

test('stable bumps promote prerelease patch versions, without skipping stable increments', () => {
    const cases = [
        ['0.3.2-alpha.3', 'patch', '0.3.2'],
        ['0.3.2-beta.1', 'patch', '0.3.2'],
        ['0.3.2-rc.4', 'patch', '0.3.2'],
        ['0.3.2-alpha.3', 'minor', '0.4.0'],
        ['0.3.2-alpha.3', 'major', '1.0.0'],
        ['0.3.1', 'patch', '0.3.2'],
        ['0.3.2', 'patch', '0.3.3'],
        ['0.3.2', 'minor', '0.4.0'],
        ['0.3.2', 'major', '1.0.0'],
    ];
    for (const [current, type, expected] of cases) {
        assert.equal(nextStableVersion(current, type), expected, `${current} + ${type}`);
    }
    assert.throws(() => nextStableVersion('0.3.2-alpha.3', 'unknown'), /Unknown release bump/);
    assert.throws(() => nextStableVersion('0.3.bad'), /Invalid release version/);
});

function fixture(current) {
    const tmp = mkdtempSync(path.join(tmpdir(), 'dc-release-promote-'));
    mkdirSync(path.join(tmp, 'src'));
    copyFileSync(path.join(root, 'manifest.template.json'), path.join(tmp, 'manifest.template.json'));
    copyFileSync(path.join(root, 'manifest.json'), path.join(tmp, 'manifest.json'));
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
        name: '@wonderwhy-er/desktop-commander', version: current,
    }));
    writeFileSync(path.join(tmp, 'server.json'), JSON.stringify({
        version: '0.3.1',
        packages: [
            { registryType: 'npm', identifier: '@wonderwhy-er/desktop-commander', version: '0.3.1' },
            { registryType: 'npm', identifier: 'not-our-package', version: '5.0.0' },
        ],
    }));
    writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({
        name: '@wonderwhy-er/desktop-commander',
        version: '0.3.1',
        lockfileVersion: 3,
        packages: {
            '': { name: '@wonderwhy-er/desktop-commander', version: '0.3.1' },
            'node_modules/example': { version: '7.8.9' },
        },
    }));
    return tmp;
}

function sync(tmp, ...args) {
    execFileSync(process.execPath, [path.join(root, 'scripts/sync-version.js'), ...args], {
        cwd: tmp, stdio: 'pipe',
    });
}

test('alpha patch promotion synchronizes npm, server, lockfile, TS and MCPB manifest', () => {
    const tmp = fixture('0.3.2-alpha.3');
    try {
        sync(tmp, '--bump');
        const pkg = json(path.join(tmp, 'package.json'));
        const srv = json(path.join(tmp, 'server.json'));
        const lock = json(path.join(tmp, 'package-lock.json'));
        const manifest = json(path.join(tmp, 'manifest.json'));
        assert.equal(pkg.version, '0.3.2');
        assert.equal(srv.version, '0.3.2');
        assert.equal(srv.packages[0].version, '0.3.2');
        assert.equal(srv.packages[1].version, '5.0.0');
        assert.equal(lock.version, '0.3.2');
        assert.equal(lock.packages[''].version, '0.3.2');
        assert.equal(lock.packages['node_modules/example'].version, '7.8.9');
        assert.equal(readFileSync(path.join(tmp, 'src/version.ts'), 'utf8'),
            "export const VERSION = '0.3.2';\n");
        const expectedManifest = json(path.join(tmp, 'manifest.template.json'));
        expectedManifest.version = '0.3.2';
        delete expectedManifest.$schema;
        assert.deepEqual(manifest, expectedManifest);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('synchronizing alpha without a stable bump leaves root stable manifest unchanged', () => {
    const tmp = fixture('0.3.2-alpha.3');
    try {
        const before = readFileSync(path.join(tmp, 'manifest.json'), 'utf8');
        sync(tmp);
        assert.equal(json(path.join(tmp, 'package.json')).version, '0.3.2-alpha.3');
        assert.equal(json(path.join(tmp, 'package-lock.json')).version, '0.3.2-alpha.3');
        assert.equal(json(path.join(tmp, 'server.json')).version, '0.3.2-alpha.3');
        assert.equal(readFileSync(path.join(tmp, 'manifest.json'), 'utf8'), before);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('GitHub workflow skip flag is opt-in and build/release checks remain mandatory', () => {
    const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(workflow, /skip_tests:\s*\n\s+description:.*\n\s+required: false\s*\n\s+type: boolean\s*\n\s+default: false/);
    assert.match(workflow, /name: Run tests \(cut mode\)\s*\n\s+if: steps\.mode\.outputs\.mode == 'cut' && !inputs\.skip_tests/);
    assert.match(workflow, /name: Note skipped release tests\s*\n\s+if: steps\.mode\.outputs\.mode == 'cut' && inputs\.skip_tests/);
    assert.match(workflow, /name: Install dependencies\s*\n\s+run: npm ci/);
    assert.match(workflow, /name: Build MCPB bundle\s*\n\s+run: npm run build:mcpb/);
    assert.match(workflow, /name: Verify MCPB bundle/);
    assert.match(workflow, /git add package\.json package-lock\.json server\.json src\/version\.ts manifest\.json/);
    assert.doesNotMatch(workflow, /Current version .* is a pre-release; set a stable version first/);
});

test('local CLI --skip-tests dispatches CI rather than running local tests', () => {
    const result = execFileSync(process.execPath, [
        path.join(root, 'scripts/publish-release.cjs'), '--skip-tests', '--dry-run',
    ], { cwd: root, encoding: 'utf8' });
    assert.match(result, /gh workflow run release\.yml --ref main -f bump=patch -f skip_tests=true/);
    assert.match(result, /DRY RUN - not dispatching/);
});
