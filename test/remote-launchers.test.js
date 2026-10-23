import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
        const original = path.join(root, "scripts/remote", `remote-${platform}.sh`);
        const dir = path.join(temp, platform);
        const bin = path.join(dir, "bin");
        const home = path.join(dir, "user home");
        mkdirSync(bin, { recursive: true });
        mkdirSync(home);
        const installed = path.join(dir, "system prefix");
        const terminalInput = path.join(dir, "terminal input");
        const source = readFileSync(original, "utf8");
        assert.equal(source.split("install_prefix=/usr/local").length, 2);
        // Only fixture copies replace system paths and terminal reads; production gets no test options.
        const script = path.join(dir, "launcher.sh");
        writeFileSync(script, source
            .replace("install_prefix=/usr/local", `install_prefix=${quote(installed)}`)
            .replaceAll("</dev/tty", `<${quote(terminalInput)}`));
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
        const realMktemp = spawnSync("/bin/sh", ["-c", "command -v mktemp"], { encoding: "utf8" }).stdout.trim();
        rmSync(path.join(bin, "mktemp"));
        executable(path.join(bin, "mktemp"), `printf '%s\\n' "$*" >> "$TEST_TEMP_CREATIONS"
exec ${quote(realMktemp)} "$@"`);
        // Protect the host even if a regression stops respecting the fixture's installation prefix.
        for (const tool of ["cp", "mkdir"]) {
            const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
            rmSync(path.join(bin, tool));
            executable(path.join(bin, tool), `for argument do destination=$argument; done
case "$destination" in "$TEST_ROOT"/*) ;; *) echo "Unsafe fixture destination: $destination" >&2; exit 98 ;; esac
exec ${quote(real)} "$@"`);
        }
        executable(path.join(bin, "id"), 'echo "${TEST_UID:-1000}"');
        executable(path.join(bin, "sudo"), `printf '%s\\n' "$*" >> "$TEST_ELEVATIONS"
case "$1" in installer|mkdir|cp) ;; *) echo "Unexpected elevated command: $1" >&2; exit 97 ;; esac
[ "\${TEST_INSTALL_FAIL:-0}" = 0 ] || exit "$TEST_INSTALL_FAIL"
[ "\${TEST_INSTALL_EMPTY:-0}" = 0 ] || exit 0
TEST_ELEVATED=1; export TEST_ELEVATED
exec "$@"`);
        executable(path.join(bin, "installer"), `[ "$1" = -pkg ] && [ -f "$2" ] && [ "$3" = -target ] && [ "$4" = / ] || exit 95
mkdir -p "$TEST_PREFIX"
tar -xzf "$2" -C "$TEST_PREFIX" --strip-components=1`);
        executable(
            path.join(bin, "uname"),
            `case "$1" in -s) echo '${platform === "macos" ? "Darwin" : "Linux"}' ;; -m) echo "\${TEST_ARCH:-x86_64}" ;; esac`,
        );
        const nodeStub = `if [ "$1" = --version ]; then
[ "\${TEST_BINARY_FAIL:-0}" = 0 ] || exit 1
echo "v\${TEST_NODE_VERSION:-22.12.0}"; exit 0; fi
exec ${quote(process.execPath)} -e 'Object.defineProperty(process.versions, "node", {value: process.env.TEST_NODE_VERSION || "22.12.0"}); eval(process.argv[1])' "$2"`;
        const npxStub = `[ "\${TEST_ELEVATED:-0}" = 0 ] || { echo 'npx must not be elevated' >&2; exit 96; }
case "$PATH" in "$TEST_ORIGINAL_PATH"|"$TEST_ORIGINAL_PATH:$TEST_PREFIX/bin") ;; *) echo 'Original PATH priority changed' >&2; exit 94 ;; esac
[ -z "\${TEST_EXPECT_UMASK:-}" ] || [ "$(umask)" = "$TEST_EXPECT_UMASK" ] || { echo 'Caller umask changed' >&2; exit 93; }
printf "%s\\n" "$@" >> "$TEST_CALLS"; exit "\${TEST_EXIT:-0}"`;
        executable(path.join(bin, "node"), nodeStub);
        executable(path.join(bin, "npx"), npxStub);
        executable(
            path.join(bin, "curl"),
            `printf '%s\\n' "$2" >> "$TEST_DOWNLOADS"
[ "\${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
case "$2" in
    https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt) cp "$TEST_MANIFEST" "$4" ;;
    https://nodejs.org/dist/v24.0.0/node-v24.0.0-*.tar.gz|https://nodejs.org/dist/v24.0.0/node-v24.0.0.pkg) cp "$TEST_ARCHIVE" "$4" ;;
    *) exit 99 ;;
esac`,
        );

        const env = {
            ...process.env,
            HOME: home,
            PATH: bin,
            TMPDIR: dir,
            TEST_ROOT: dir,
            TEST_PREFIX: installed,
            TEST_ORIGINAL_PATH: bin,
            TEST_ELEVATIONS: path.join(dir, "elevations"),
            TEST_TEMP_CREATIONS: path.join(dir, "temporary-directory-creations"),
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
            expect(spawnSync(shell, ["-n", original], { encoding: "utf8" }), 0);
            const existing = run({}, shell);
            expect(existing, 0);
            assert.doesNotMatch(existing.stdout, /Would you like to continue/);
        }
        expect(run({}, "/bin/sh", readFileSync(script, "utf8")), 0);
        assert.equal(existsSync(env.TEST_DOWNLOADS), false, "Existing Node must not trigger a download");
        assert.equal(existsSync(env.TEST_ELEVATIONS), false, "Existing Node must not request administrator access");
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
            assert.match(result.stderr, /Your Node\.js version is too old/);
        }
        rmSync(path.join(bin, "npx"));
        const missingNpx = run();
        expect(missingNpx, 1);
        assert.match(missingNpx.stderr, /Your Node\.js installation is incomplete/);
        assert.equal(readFileSync(env.TEST_CALLS, "utf8"), callsBeforeFailure);
        assert.equal(existsSync(env.TEST_DOWNLOADS), false, "Existing incompatible or incomplete Node must not be replaced");
        rmSync(path.join(bin, "node"));

        mkdirSync(path.join(installed, "bin"), { recursive: true });
        executable(path.join(installed, "bin/node"), nodeStub);
        executable(path.join(installed, "bin/npx"), npxStub);
        const standardInstallation = run();
        expect(standardInstallation, 0);
        assert.doesNotMatch(standardInstallation.stdout, /Would you like to continue/);
        assert.equal(existsSync(env.TEST_DOWNLOADS), false, "An installed Node outside PATH must be reused");
        assert.equal(existsSync(env.TEST_ELEVATIONS), false);
        rmSync(installed, { recursive: true });
        const previousPrivateNode = path.join(home, ".local/share/desktop-commander/node/bin");
        mkdirSync(previousPrivateNode, { recursive: true });
        executable(path.join(previousPrivateNode, "node"), nodeStub);

        const callsBeforeConsent = readFileSync(env.TEST_CALLS, "utf8");
        const manualDownloads = platform === "macos" ? {
            x86_64: "https://nodejs.org/dist/v24.22.1/node-v24.22.1.pkg",
            arm64: "https://nodejs.org/dist/v24.22.1/node-v24.22.1.pkg",
            unsupported: null,
        } : {
            x86_64: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz",
            aarch64: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz",
            arm64: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz",
            unsupported: null,
        };
        for (const [architecture, downloadUrl] of Object.entries(manualDownloads)) {
            for (const answer of ["n\n", "No\n", "\n", "maybe\n", " yes \n", "", "yes"]) {
                writeFileSync(terminalInput, answer);
                const declined = run({ TEST_ARCH: architecture }, "/bin/sh", readFileSync(script, "utf8"));
                expect(declined, 0);
                assert.match(declined.stdout, /Remote Desktop Commander needs Node\.js, which could not be found on this computer\./);
                assert.match(declined.stdout, /If you choose Yes, we will install Node\.js 24, then download and start Remote Desktop Commander\./);
                assert.match(declined.stdout, /Would you like to continue\? Type Yes or No \(press Enter for No\): /);
                const lines = declined.stdout.split("\n");
                assert.ok(lines.includes("Node.js could not be found. You can choose either option:"));
                assert.ok(lines.includes("1. If Node.js is already installed, open a new Terminal window and run:"));
                assert.ok(lines.includes("npx @wonderwhy-er/desktop-commander@latest remote"));
                if (downloadUrl) {
                    assert.ok(lines.includes("2. To install Node.js yourself, use this download link:"));
                    assert.ok(lines.includes(downloadUrl), `${architecture} must get the matching direct download`);
                    assert.ok(lines.includes(platform === "macos"
                        ? "Open the downloaded file to install Node.js. Then open a new Terminal window and run the command above."
                        : "After installing Node.js, open a new Terminal window and run the command above."));
                } else {
                    assert.ok(lines.includes("2. We do not have a compatible Node.js download link for this computer."));
                    assert.doesNotMatch(declined.stdout, /https:\/\/nodejs\.org/, "Unknown CPUs must not receive an incompatible download");
                }
                assert.equal(existsSync(env.TEST_DOWNLOADS), false, "Declining must not download Node");
                assert.equal(existsSync(env.TEST_ELEVATIONS), false, "Declining must not request administrator access");
                assert.equal(existsSync(env.TEST_TEMP_CREATIONS), false, "Declining must not create a temporary directory");
                assert.equal(existsSync(installed), false, "Declining must not install Node");
                assert.equal(readFileSync(env.TEST_CALLS, "utf8"), callsBeforeConsent, "Declining must not start Desktop Commander");
            }
        }
        rmSync(terminalInput);
        const noTerminal = run({}, "/bin/sh", readFileSync(script, "utf8"));
        expect(noTerminal, 1);
        assert.match(noTerminal.stderr, /We could not read your answer\. Please open Terminal and run this command again\./);
        assert.equal(existsSync(env.TEST_DOWNLOADS), false);
        assert.equal(existsSync(env.TEST_ELEVATIONS), false);
        assert.equal(existsSync(env.TEST_TEMP_CREATIONS), false);
        assert.equal(existsSync(installed), false);
        assert.equal(readFileSync(env.TEST_CALLS, "utf8"), callsBeforeConsent);

        // Acceptance reaches the first download; the existing fixtures below exercise full installation.
        for (const answer of ["y\n", "Y\n", "yes\n", "YES\n", "yEs\n"]) {
            writeFileSync(terminalInput, answer);
            expect(run({ TEST_DOWNLOAD_FAIL: "1" }, "/bin/sh", readFileSync(script, "utf8")), 22);
        }
        writeFileSync(terminalInput, "YeS\n");

        for (const arch of ["x64", "arm64"]) {
            const archiveRoot = `node-v24.0.0-${platform === "macos" ? "darwin" : "linux"}-${arch}`;
            const archiveBin = path.join(dir, archiveRoot, "bin");
            mkdirSync(archiveBin, { recursive: true });
            for (const part of ["include", "lib", "share"]) mkdirSync(path.join(dir, archiveRoot, part), { recursive: true });
            mkdirSync(path.join(dir, archiveRoot, "lib/node_modules/npm"), { recursive: true });
            writeFileSync(path.join(dir, archiveRoot, "lib/node_modules/npm/package.json"), '{"name":"npm"}\n', { mode: 0o644 });
            executable(path.join(archiveBin, "node"), nodeStub);
            executable(path.join(archiveBin, "npx"), npxStub);
            const tar = spawnSync("tar", ["-czf", env.TEST_ARCHIVE, "-C", dir, archiveRoot]);
            assert.equal(tar.status, 0);
            const checksum = createHash("sha256").update(readFileSync(env.TEST_ARCHIVE)).digest("hex");
            const filename = platform === "macos" ? "node-v24.0.0.pkg" : `${archiveRoot}.tar.gz`;
            const manifest = `${checksum}  ${filename.replace("v24.0.0", "v22.23.4")}\n${checksum}  ${filename}\n`;
            writeFileSync(env.TEST_MANIFEST, manifest);
            const archEnv = { TEST_ARCH: arch === "x64" ? "x86_64" : platform === "macos" ? "arm64" : "aarch64" };
            const callsBeforeInstall = readFileSync(env.TEST_CALLS, "utf8");
            if (platform === "linux") {
                const elevations = existsSync(env.TEST_ELEVATIONS) ? readFileSync(env.TEST_ELEVATIONS, "utf8") : "";
                const incompatible = run({ ...archEnv, TEST_BINARY_FAIL: "1" });
                expect(incompatible, 1);
                assert.match(incompatible.stderr, /This computer cannot run the downloaded Node\.js version/);
                assert.equal(existsSync(env.TEST_ELEVATIONS) ? readFileSync(env.TEST_ELEVATIONS, "utf8") : "", elevations);
                assert.equal(existsSync(installed), false, "Unsupported Linux must fail before system writes");
            }
            expect(run({ ...archEnv, TEST_INSTALL_FAIL: "9" }), 9);
            assert.equal(existsSync(installed), false);
            const emptyInstall = run({ ...archEnv, TEST_INSTALL_EMPTY: "1" });
            expect(emptyInstall, 1);
            assert.match(emptyInstall.stderr, /We could not finish installing Node\.js/);
            assert.equal(readFileSync(env.TEST_CALLS, "utf8"), callsBeforeInstall, "Failed installs must not launch Desktop Commander");
            mkdirSync(installed);
            writeFileSync(path.join(installed, "unrelated-file"), "keep existing system files");
            chmodSync(path.join(installed, "unrelated-file"), 0o600);
            if (platform === "linux") {
                expect(run({ ...archEnv, TEST_EXPECT_UMASK: "0077" }, "/bin/sh", `umask 077\n${readFileSync(script, "utf8")}`), 0);
                for (const installedPath of ["bin", "bin/node", "bin/npx", "lib", "lib/node_modules/npm", "include", "share"]) {
                    assert.equal(statSync(path.join(installed, installedPath)).mode & 0o777, 0o755, `${installedPath} must be usable beyond root`);
                }
                assert.equal(statSync(path.join(installed, "lib/node_modules/npm/package.json")).mode & 0o777, 0o644, "npm files must stay readable beyond root");
            } else {
                expect(run(archEnv), 0);
            }
            assert.ok(existsSync(path.join(installed, "bin/node")));
            assert.equal(readFileSync(path.join(installed, "unrelated-file"), "utf8"), "keep existing system files");
            assert.equal(statSync(path.join(installed, "unrelated-file")).mode & 0o777, 0o600, "Do not change existing system-file permissions");
            const elevations = readFileSync(env.TEST_ELEVATIONS, "utf8");
            assert.match(elevations, platform === "macos" ? /installer -pkg .*\.pkg -target \/\n/ : /cp -R /);
            const downloads = readFileSync(env.TEST_DOWNLOADS, "utf8");
            expect(run(archEnv, "/bin/sh", readFileSync(script, "utf8")), 0);
            assert.equal(readFileSync(env.TEST_DOWNLOADS, "utf8"), downloads, "Repeat runs must reuse standard Node");
            assert.equal(readFileSync(env.TEST_ELEVATIONS, "utf8"), elevations, "Repeat runs must not elevate");
            rmSync(installed, { recursive: true });

            writeFileSync(env.TEST_MANIFEST, manifest.replaceAll(checksum, "0".repeat(64)));
            const corrupt = run(archEnv);
            assert.notEqual(corrupt.status, 0);
            assert.match(corrupt.stderr, /The Node\.js download could not be verified/);
            assert.equal(existsSync(installed), false);
            assert.equal(readFileSync(env.TEST_ELEVATIONS, "utf8"), elevations, "Checksum failure must precede elevation");
            checks++;
            writeFileSync(env.TEST_MANIFEST, manifest);
            if (platform === "linux") {
                expect(run({ ...archEnv, TEST_EXPECT_UMASK: "0077" }, "/bin/sh", `umask 077\n${readFileSync(script, "utf8")}`), 0);
                assert.equal(statSync(installed).mode & 0o777, 0o755, "A new system prefix must be accessible beyond root");
                rmSync(installed, { recursive: true });
            }
        }
        const elevations = readFileSync(env.TEST_ELEVATIONS, "utf8");
        const validManifest = readFileSync(env.TEST_MANIFEST, "utf8");
        const failedDownload = run({ TEST_DOWNLOAD_FAIL: "1" });
        expect(failedDownload, 22);
        assert.equal(existsSync(installed), false);
        expect(run({ TEST_ARCH: "unsupported" }), 1);
        writeFileSync(env.TEST_MANIFEST, "no matching archive\n");
        const invalidManifest = run();
        expect(invalidManifest, 1);
        assert.match(invalidManifest.stderr, /We could not find the Node\.js download/);
        assert.equal(existsSync(installed), false);
        assert.equal(readFileSync(env.TEST_ELEVATIONS, "utf8"), elevations);
        writeFileSync(env.TEST_MANIFEST, validManifest);
        rmSync(path.join(bin, "sudo"));
        const missingSudo = run({ TEST_ARCH: "arm64" });
        expect(missingSudo, 1);
        assert.match(missingSudo.stderr, /We could not install Node\.js automatically/);
        if (platform === "linux") {
            expect(run({ TEST_ARCH: "arm64", TEST_UID: "0", TEST_EXPECT_UMASK: "0077" }, "/bin/sh", `umask 077\n${readFileSync(script, "utf8")}`), 0);
            assert.equal(statSync(installed).mode & 0o777, 0o755, "Direct root installation must create an accessible prefix");
        } else {
            expect(run({ TEST_ARCH: "arm64", TEST_UID: "0" }), 0);
        }
        assert.equal(readFileSync(env.TEST_ELEVATIONS, "utf8"), elevations, "An originally root caller needs no sudo");
        assert.equal(readFileSync(path.join(previousPrivateNode, "node"), "utf8"), `#!/bin/sh\n${nodeStub}\n`, "Previous private installations remain untouched");
    }
    console.log(`PASS remote launchers: ${checks} shell checks (downloads, elevation, system installs, and device commands stubbed)`);
} finally {
    rmSync(temp, { recursive: true, force: true });
}
