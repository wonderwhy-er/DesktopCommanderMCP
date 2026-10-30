# Tests

Every test file here is a Node script: it **passes when its process exits with 0**. The runners start each file through Node's test runner (`node:test`) in its own process, one after another, from the file's folder, with its own temporary home, so no test can touch the real `~/.claude-server-commander`. A file doesn't need to use `node:test`; one that does also gets each of its tests reported.

## Running them

| Command | What it runs |
|---|---|
| `npm test` | builds, then every `test/test*.js` and `test/*.test.js`, less the excluded ones (below) |
| `node test/run-all-tests.js test-a.js test-b.js` | the files named (add `--no-build` when `dist/` is fresh) |
| `node test/repro/run-repro.js [names]` | the repro scripts in `test/repro/`, each stopped after 180 s |
| `npm run test:integration` | `test/integration/` |
| `npm run test:changed` | only the files a change reaches (below) |
| `npm run test:ci` | what CI runs: the suite, the repro scripts and the integration tests, without the timed tests in `test/timed.txt` |
| `npm run test:coverage` | the same under c8, with the coverage report |

The runners (the Docker runner, `test/docker/run-docker-tests.js`, too) take the same options:
- `--changed [A [B]]`: only the files a change reaches (below).
- `--shard <i>/<n>`: the i-th of n parts of the files.
- `--skip <name>`: leave that file out.
- `--out <dir>`: where the reports go.

They also take `--timed` and `--without-timed`: only, or without, their timed tests in `test/timed.txt` (below). The old `--run-alone` and `--without-run-alone` stop with their new names. `run-all-tests.js` also takes `--no-build`.

## Writing a test

- **The usual shape:** export the test's function and run it through `runIfMain(import.meta.url, run)` (`helpers/run-if-main.js`). The file then exits with 0 when the function returns, and 1 when it throws or returns `false`.
- **Skipping a check:** when something the check needs is missing on the machine (Python, PowerShell, a drive letter), end it with `return skip('why')`. The file still passes, and the runner lists the skip in its summary and its reports.
- **Files under `dist/`:** tests import the built code, so build first (`npm test` does).
- **The server:** a test that needs it starts it through `helpers/mcp-client.js`.
- **Temporary folders:** make them with `createTempDir()` (`helpers/test-env.js`). It gives the real path; macOS's temporary folder is behind a link.

## Tests that measure time

A busy machine makes everything slower, and the runners share machines with other runs. So a check that involves time is written to hold up under load:
- **A wait for something to happen** (a file to appear, a process to end) gets a deadline a loaded machine still meets, 30 to 60 seconds. It returns as soon as the thing happens, so a passing run is no slower.
- **A check whose point is a time** (it must not wait for X) compares with something measured in the same run on the same machine, or makes X take much longer than the limit. For example, a process that runs 30 seconds against a 10-second limit.
- **A check that races a time limit the product itself sets** (a 1.5-second default, a 3-second budget) can't be loosened without missing the bug. It's a timed test: its file goes into `test/timed.txt`. The timed tests run one after another, on a quiet machine (`--timed`), and every other run leaves them out (`--without-timed`).

## The test lists

A new test runs without being added anywhere:
- the suite runs every `test/test*.js` and `test/*.test.js`;
- the repro runner, every `test/repro/test-*.js`;
- the integration runner, every file in `test/integration/`;
- the Docker runner, every `test/docker/test-*.js`;
- `test/test-powershell-tests.js`, every `test/*.test.ps1`, with Windows PowerShell on Windows and `pwsh` elsewhere.

A runner given no names that finds no test file in its folder fails, rather than passing with nothing run. Docker's runner, whose folder has no test yet, passes only with `--none-ok`, and says so.

Two files hold the exceptions, read by `readTestList` (`helpers/node-test-runner.js`). One test per line, `<name>  # <reason>`: a suite file by its name, the others as `repro/<name>`, `integration/<name>` or `docker/<name>`. A line without a reason, naming a file that isn't there, or naming one no runner finds by name (a helper, a fixture, a `.ps1` test: `test-powershell-tests.js` runs those), stops the run.
- **`test/timed.txt`:** the timed tests (above).
- **`test/excluded.txt`:** tests that never run in CI, for the reason on their line, such as a service CI doesn't have. The runners leave them out of the files they find and list them in their reports; one named on the command line still runs. `test/excluded.txt` lists no test now.

## Reports

Each runner writes, in `test-results/suite/`, `test-results/repro/` or `test-results/integration/`:

| File | What |
|---|---|
| `junit.xml` | JUnit XML: a testcase per file; a failed file's last output lines in its `<failure>`; a skipped testcase per skipped check; the tests of `node:test` files |
| `results.json` | the same as JSON: each file's result, exit code, time, skipped checks and, on a failure, its last output lines; and the tests `test/excluded.txt` left out, with their reasons |
| `results.tap` | `node:test`'s TAP report |
| `selection.md` | with `--changed`: which files were picked, and why |

`npm run test:coverage` writes `coverage/`. It holds the HTML report (`coverage/index.html`, a page per source file with each line marked), `lcov.info`, `coverage-final.json`, `coverage-summary.json` and `cobertura-coverage.xml`, and prints a text summary.
- **What it counts:** our source, each file shown as itself (`.c8rc.json`). Nothing from `dist/`, `node_modules/`, the tests or `scripts/`. Counted are:
  - every file under `src/` (`.ts` and `.js`);
  - the install scripts the package ships at its root: `setup-claude-server.js` (bin `setup`), `uninstall-claude-server.js` (bin `remove`), `track-installation.js` (postinstall);
  - the vendored `vendor/telemetry-contract/`, without its tests;
  - the test tooling: the runners, `test/run-ci.js` and the coverage scripts, listed in `TEST_TOOLING` (`test/check-coverage-report.js`). It's a feature with its own tests (`test/test-coverage-areas.js`, `test-check-coverage-report.js`, `test-map-copied-scripts.js`, `test-run-coverage.js`, `test-run-ci.js`, `test-select-tests.js`, `test-node-test-runner.js`, `test-runner-scripts.js`).
- **How:** c8 follows every Node process that keeps the test's environment, the server the tests start included, and maps `dist/` back to `src/` through the source maps of the coverage build: `tsconfig.coverage.json` for the TypeScript, and `test/map-copied-scripts.js` for the plain `.js` files the build copies into `dist/` (from `src/`, and the install scripts).
- **Files no test loads** show at 0 %.
- **By area:** the run prints the numbers per folder of `src/` (`src/ui` among them), plus `install scripts`, `vendor/telemetry-contract` and `test tooling`, then one total (`test/coverage-areas.js`).
- **The npm package never ships those source maps:** the next `npm run build` drops them.
- **A test that rebuilds `dist/`** would drop those source maps for everything after it. `repro/test-release-packages-ship-contract.js` does, through `npm pack`, which runs the build under npm 10. Under coverage it runs last and uncovered, and the coverage build is made again after it (`test/run-ci.js`).
- **The report is checked:** `test/check-coverage-report.js` fails on any file it doesn't count (a `dist/` file means something went unmapped) and on any counted file the report doesn't list.

## Per-change runs

`--changed` runs only the files a change can affect. It has two forms.
- **`--changed [A]`, while you work:** the commits since `A`, plus uncommitted changes and new files. `A` defaults to where your branch left `origin/main`, so `npm run test:changed` is what your branch changes so far. The uncommitted files are marked as such in the printed list and in `selection.md`.
- **`--changed A B`, to compare two commits:** only what changed from commit `A` to commit `B`, with the imports read from `B` through git, whatever is edited. Run at `B`, any machine gives the same answer. For example `npm run test:changed -- origin/main HEAD`.
- **How a file is picked:** `helpers/select-tests.js` follows each test file's imports through `test/` and `src/`. An import of `dist/x.js` counts as `src/x.ts`. A test is picked when a changed file is in its reach.
- **Links no import shows:**
  - the server a helper starts (`dist/index.js`, named as a path);
  - the UI apps, which `src/ui/resources.ts` reads from `dist/ui/`;
  - a file a test names by its file name, such as `install-docker.sh`, a fixture it starts by its path, or a preload it passes to `--import`.
- **When everything runs:** a change to `package.json`, the lockfile, a `tsconfig`, the runners or their helpers runs every file. So does a changed file in `src/` or `test/helpers/` the graph doesn't know.
- **`selection.md`** lists each picked file with the chain of imports that reaches the changed file. It also lists the changed files no test reaches (in `src/`, `scripts/`, `test/fixtures/`, `test/helpers/`).

A change to a shared module reaches most tests, because many tests start the whole server. `--changed` saves the most for changes to tests themselves. Run everything once before you push.
