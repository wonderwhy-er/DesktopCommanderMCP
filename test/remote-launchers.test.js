import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const temp = mkdtempSync(path.join(tmpdir(), "dc-launcher-test-"));
let checks = 0;

function executable(file, source) {
    writeFileSync(file, `#!/bin/sh\n${source}\n`);
    chmodSync(file, 0o755);
}

try {
    for (const platform of ["macos", "linux"]) {
        const script = path.join(root, "scripts/remote", `remote-${platform}.sh`);
        const dir = path.join(temp, platform);
        const bin = path.join(dir, "bin");
        const home = path.join(dir, "user home");
        mkdirSync(bin, { recursive: true });
        mkdirSync(home);
        for (const tool of ["awk", "mkdir", "dirname", "mktemp", "rm", "mv", "tar", "shasum", "sha256sum", "cp"]) {
            const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
            if (found.status === 0) {
                symlinkSync(found.stdout.trim(), path.join(bin, tool));
            }
        }
        // macOS may only ship shasum; provide the Linux equivalent for this fixture.
        if (!existsSync(path.join(bin, "sha256sum"))) {
            executable(path.join(bin, "sha256sum"), 'exec shasum -a 256 "$@"');
        }
        executable(
            path.join(bin, "uname"),
            `case "$1" in -s) echo '${platform === "macos" ? "Darwin" : "Linux"}' ;; -m) echo "\${TEST_ARCH:-x86_64}" ;; esac`,
        );
        const nodeStub = `if [ "$1" = --version ]; then echo "v\${TEST_NODE_VERSION:-22.12.0}"; exit 0; fi
exec ${quote(process.execPath)} -e 'Object.defineProperty(process.versions, "node", {value: process.env.TEST_NODE_VERSION || "22.12.0"}); eval(process.argv[1])' "$2"`;
        const npxStub = 'printf "%s\\n" "$@" >> "$TEST_CALLS"; exit "${TEST_EXIT:-0}"';
        executable(path.join(bin, "node"), nodeStub);
        executable(path.join(bin, "npx"), npxStub);
        executable(
            path.join(bin, "curl"),
            `printf '%s\\n' "$2" >> "$TEST_DOWNLOADS"
[ "\${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
case "$2" in
    https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt) cp "$TEST_MANIFEST" "$4" ;;
    https://nodejs.org/dist/v22.23.4/node-v22.23.4-*.tar.gz) cp "$TEST_ARCHIVE" "$4" ;;
    *) exit 99 ;;
esac`,
        );

        const env = {
            ...process.env,
            HOME: home,
            PATH: bin,
            TEST_CALLS: path.join(dir, "calls"),
            TEST_DOWNLOADS: path.join(dir, "downloads"),
            TEST_MANIFEST: path.join(dir, "SHASUMS256.txt"),
            TEST_ARCHIVE: path.join(dir, "node.tar.gz"),
        };
        const run = (extra = {}, shell = "/bin/sh", input = undefined) =>
            spawnSync(shell, input === undefined ? [script] : [], { env: { ...env, ...extra }, encoding: "utf8", input, timeout: 10000 });
        const expect = (result, status) => {
            assert.equal(result.status, status, result.stderr || result.error?.message);
            checks++;
        };
        for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"].filter(existsSync)) {
            expect(run({}, shell), 0);
        }
        expect(run({}, "/bin/sh", readFileSync(script, "utf8")), 0);
        assert.equal(existsSync(env.TEST_DOWNLOADS), false, "Existing Node must not trigger a download");
        assert.deepEqual(readFileSync(env.TEST_CALLS, "utf8").trim().split("\n").slice(0, 3), [
            "--yes",
            "@wonderwhy-er/desktop-commander@latest",
            "remote",
        ]);
        expect(run({ TEST_EXIT: "7" }), 7);
        for (const version of ["22.12.0", "22.23.4", "24.0.0"]) {
            expect(run({ TEST_NODE_VERSION: version }), 0);
        }
        const callsBeforeFailure = readFileSync(env.TEST_CALLS, "utf8");
        for (const version of ["20.19.0", "22.11.0"]) {
            const result = run({ TEST_NODE_VERSION: version });
            expect(result, 1);
            assert.match(result.stderr, /22\.12\+ is required/);
        }
        rmSync(path.join(bin, "npx"));
        const missingNpx = run();
        expect(missingNpx, 1);
        assert.match(missingNpx.stderr, /npx is missing/);
        assert.equal(readFileSync(env.TEST_CALLS, "utf8"), callsBeforeFailure);
        rmSync(path.join(bin, "node"));

        const installed = path.join(home, ".local/share/desktop-commander/node");
        for (const arch of ["x64", "arm64"]) {
            const archiveRoot = `node-v22.23.4-${platform === "macos" ? "darwin" : "linux"}-${arch}`;
            const archiveBin = path.join(dir, archiveRoot, "bin");
            mkdirSync(archiveBin, { recursive: true });
            executable(path.join(archiveBin, "node"), nodeStub);
            executable(path.join(archiveBin, "npx"), npxStub);
            const tar = spawnSync("tar", ["-czf", env.TEST_ARCHIVE, "-C", dir, archiveRoot]);
            assert.equal(tar.status, 0);
            const checksum = createHash("sha256").update(readFileSync(env.TEST_ARCHIVE)).digest("hex");
            const manifest = `${checksum}  ${archiveRoot}.tar.gz\n`;
            writeFileSync(env.TEST_MANIFEST, manifest);
            const archEnv = { TEST_ARCH: arch === "x64" ? "x86_64" : platform === "macos" ? "arm64" : "aarch64" };
            expect(run(archEnv), 0);
            assert.ok(existsSync(path.join(installed, "bin/node")));
            const downloads = readFileSync(env.TEST_DOWNLOADS, "utf8");
            expect(run(archEnv), 0);
            assert.equal(readFileSync(env.TEST_DOWNLOADS, "utf8"), downloads, "Repeat runs must reuse private Node");
            rmSync(installed, { recursive: true });

            writeFileSync(env.TEST_MANIFEST, manifest.replace(checksum, "0".repeat(64)));
            const corrupt = run(archEnv);
            assert.notEqual(corrupt.status, 0);
            assert.match(corrupt.stderr, /checksum verification failed/);
            assert.equal(existsSync(installed), false);
            checks++;
        }
        const failedDownload = run({ TEST_DOWNLOAD_FAIL: "1" });
        expect(failedDownload, 22);
        assert.equal(existsSync(installed), false);
        expect(run({ TEST_ARCH: "unsupported" }), 1);
        writeFileSync(env.TEST_MANIFEST, "no matching archive\n");
        const invalidManifest = run();
        expect(invalidManifest, 1);
        assert.match(invalidManifest.stderr, /No matching Node.js download/);
        assert.equal(existsSync(installed), false);
    }
    console.log(`PASS remote launchers: ${checks} shell checks (downloads and device command stubbed)`);
} finally {
    rmSync(temp, { recursive: true, force: true });
}
