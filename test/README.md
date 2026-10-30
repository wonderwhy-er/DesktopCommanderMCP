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
- **`test/excluded.txt`:** tests that never run in CI, for the reason on their line, such as a service CI doesn't have. The runners leave them out of the files they find, list them in their reports, and the PR comment counts them; one named on the command line still runs. `test/excluded.txt` lists no test now.

## Reports

Each runner writes, in `test-results/suite/`, `test-results/repro/` or `test-results/integration/`:

| File | What |
|---|---|
| `junit.xml` | JUnit XML: a testcase per file; a failed file's last output lines in its `<failure>`; a skipped testcase per skipped check; the tests of `node:test` files |
| `results.json` | the same as JSON: each file's result, exit code, time, skipped checks and, on a failure, its last output lines; and the tests `test/excluded.txt` left out, with their reasons |
| `results.tap` | `node:test`'s TAP report |
| `selection.md` | with `--changed`: which files were picked, and why |

`npm run test:coverage` writes `coverage/`. It holds the HTML report (`coverage/index.html`, a page per source file with each line marked), `lcov.info`, `coverage-final.json`, `coverage-summary.json` and `cobertura-coverage.xml`, and prints a text summary.
- **What it counts:** the product code, each file shown as itself (`.c8rc.json`). Counted are:
  - every file under `src/` (`.ts` and `.js`);
  - the install scripts the package ships at its root: `setup-claude-server.js` (bin `setup`), `uninstall-claude-server.js` (bin `remove`), `track-installation.js` (postinstall);
  - the vendored `vendor/telemetry-contract/`, without its tests.
- **Not counted:** `dist/`, `node_modules/`, `scripts/` and `test/`, as in a usual setup. `test/` holds the tests and the runners, coverage and CI scripts. Those scripts have tests of their own (`test/test-coverage-areas.js`, `test-check-coverage-report.js`, `test-map-copied-scripts.js`, `test-run-coverage.js`, `test-run-ci.js`, `test-ci-comment.js`, `test-ci-platforms.js`, `test-ci-review.js`, `test-select-tests.js`, `test-node-test-runner.js`, `test-runner-scripts.js`), which still run.
- **How:** c8 follows every Node process that keeps the test's environment, the server the tests start included, and maps `dist/` back to `src/` through the source maps of the coverage build: `tsconfig.coverage.json` for the TypeScript, and `test/map-copied-scripts.js` for the plain `.js` files the build copies into `dist/` (from `src/`, and the install scripts).
- **Files no test loads** show at 0 %.
- **By area:** the run prints, and the PR comment shows, the numbers per folder of `src/` (`src/ui` among them), plus `install scripts` and `vendor/telemetry-contract`, then one total (`test/coverage-areas.js`).
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

## CI

`.github/workflows/tests.yml` runs on pull requests opened by the maintainers in `MAINTAINERS` (`test/helpers/ci-platforms.js`), the one list both workflows check.
- **Platforms: add the `linux` label to run the tests on Linux.** The same goes for `windows` and `macos`. With none of them, nothing runs.
  - A push runs every labelled platform. A new push cancels the older push's run.
  - Adding a label runs its platform at once. Another label, or removing one, runs nothing and cancels nothing.
  - A PR opened with its labels runs each platform once: GitHub sends a label event for each, and opening the PR starts nothing itself.
  - A first job, `platforms`, picks them (`test/ci-platforms.js`, `test/helpers/ci-platforms.js`).
- **From a PR comment:** a maintainer writes `/test linux`, `/test windows` or `/test macos`, or several at once (`/test windows macos`), and CI runs those platforms on the PR's head.
  - Only comments from the logins in `MAINTAINERS` count. Other comments are ignored.
  - **It only works once this workflow is on main:** GitHub runs comment-started workflows from the default branch's workflow file.
- **On demand:** `gh workflow run tests.yml -f commit=<sha> -f platforms=linux,windows -f tests=<value>` runs exactly that commit on those platforms (Linux when none). GitHub lets only people with write access start it, and it works once this workflow is on main. The `tests` values (`test/run-ci.js`'s `planFor`):
  - empty, the default: everything a push or label run runs (below), shown as "everything" in the comment;
  - `test`: the suite (`npm test`'s files); `integration`; `repro`; `docker`: `test/docker/`, Linux only, failing when there's none to run;
  - `timed`: the timed tests in `test/timed.txt`, one job per test and platform, each alone on its own runner, without coverage. Each job's results are an artifact of their own (`results-<runner>-timed-<test>`, a `/` as `-`). The comment's row for the platform counts them all, and a job that stopped before its test ran counts as failed, with its step;
  - `changed:A..B`: what a push runs, each runner with `--changed A B`;
  - `files:a.js,b.js`: exactly those, each through its folder's runner (`test/`, `repro/`, `integration/`, `docker/`).
  - The run checks out the commit, with a read-only token and no npm cache. When the commit is an open PR's head, its rows go into that PR's comment, with the `tests` value (`Ran`) and the commit. Otherwise only the job summary has them: a run of an older commit leaves the comment as it is.
- **How a `/test` or on-demand run stays safe:** GitHub starts both from main's workflow, with the repository's token, on code no one has merged. So:
  - only a commenter in `MAINTAINERS` starts a `/test` run, and only someone with write access an on-demand one;
  - the first job reads the commit's full SHA once (an on-demand `commit` must be a SHA), and the test job checks out exactly that commit;
  - the inputs reach the scripts only through the environment, and the PR number found for a commit is checked to be a number;
  - the test job has a read-only token (`contents: read`), names no secret, and skips the npm cache;
  - the comment job runs main's script and reads the artifacts as data.
- **What runs:** `npm run test:coverage`, so everything but the timed tests in `test/timed.txt`, on Node 22 with npm 11:
  - the suite, the repro scripts and the integration tests, under coverage;
  - Docker's tests (`test/docker/`) on Linux, outside coverage: one checks the shell installers, which coverage can't count, and the other runs the server inside the image. With none at the commit, that part passes and says so. On Windows and macOS they don't run, and the comment says why (GitHub's macOS runner has no Docker; its Windows runner has none for Linux containers);
  - the release-packages repro last, outside coverage (`test/run-ci.js`).

  npm 11, because Node 22's own npm 10 runs the prepare build inside `npm pack` even with ignore-scripts, which breaks `repro/test-release-packages-ship-contract.js`.
- **Artifacts:** each platform uploads `results-<runner>` (`test-results/`) and `coverage-<runner>` (`coverage/`), e.g. `coverage-ubuntu-latest`. They download as zip files (logged in); open the coverage report's `index.html`.
- **The PR comment:** a last job writes one comment on the PR, with no prose. It has:
  - a heading with the commit;
  - the results: a row per platform, with its tests passed of how many, what it ran (`everything` for what a push runs), with a note for a part that didn't run and why, how many tests `test/excluded.txt` leaves out (`; 2 excluded (test/excluded.txt)`) and how many checks were skipped, its test job's minutes (`…` while it runs), its commit and its run;
  - it fails closed: a job that failed while its results show no failure, a `results.json` that can't be read, and a run where no test file ran each make the row ❌ and say which;
  - the coverage: a row per platform, with lines, branches and functions, and links to its report and results;
  - the lines by area, collapsed, a column per platform, then one total.
- **A run replaces only its own platforms' rows,** so a platform that didn't run in the latest push keeps its last row, with its own commit. The comment keeps each platform's results as hidden data for that. The job summary has the same text.

## AI review

`npm run review -- <commit A>..<commit B>` reviews the change from A to B with Gemini CLI, by the rules in `.github/review-prompt.md` and the writing style in `.github/writing-style.md`, on your machine. It needs the key in `DC_GEMINI_API_KEY`; without it, it stops at once and fails. It writes `test-results/review/`:
- `review.md`: one line with the result and the summary, then a table `| Kind | Where | What |`, one line per finding;
- `review.json`: the same findings, each with its kind (real bug, nitpick, handled elsewhere, not checked), file, line and text, and the run's tokens;
- `diff.patch`, and `answer.json`, Gemini CLI's own JSON.

The review is given the run's tests: the files that failed, and the changed lines no test ran, from `lcov.info` with every platform together. Each uncovered range becomes a `not covered` finding unless the PR says why. On your machine it uses `coverage/` and `test-results/` from the last `npm run test:coverage` only if that ran at B on a clean tree (its stamp, `coverage/run.json`); `--tests <folder>` names another run. Without results it says "with no test results".

In CI the review comes after the tests: `.github/workflows/tests.yml` runs the PR's labelled platforms, then calls `.github/workflows/review.yml` (the same script, with the `GEMINI_API_KEY` secret), passed or failed, with the run's results and coverage. The same maintainers start it, in the same ways as the tests:
- **Add the `review` label** to test the labelled platforms and review the PR at once. A push to a PR with the label tests and reviews it again.
- **From a PR comment:** a line `/review`, with the same labelled platforms first. It only works once the workflows are on main, as for `/test`.
- **With no platform label,** the review runs alone and says it had no test results.
- **On demand:** `gh workflow run review.yml -f commit=<sha> -f base=<sha or branch>`, a review alone, also once it's on main.

What CI posts: one review with event COMMENT, never an approval. Its body is one line with the result and the summary, then the table of every finding; a finding on a line the diff changes is also a one-line comment on that line. The run's job summary and its `review` artifact always have every finding, so a commit no PR has as its head still gets them there. Without the secret, the review job fails.

How it stays safe (`test/ci-review.js`, `test/helpers/ci-review.js`):
- `tests.yml`'s first job decides with `reviewFor` (`test/helpers/ci-platforms.js`, through `test/ci-review.js request`) and reads the PR's head and base; `review.yml`'s `request` job takes them as given, or decides itself on demand.
- `review` holds the only secret, `GEMINI_API_KEY`, with a read-only token. Gemini CLI (`@google/gemini-cli`, a fixed version) runs headless in a folder of its own: our settings, its own Gemini home, B's files written by git (a link as a plain file), and the diff. It can only read files (`read_file`, `list_directory`, `glob`, `grep_search`): no shell, no web, no GitHub tools, no GitHub token. An answer that holds the key writes no review.
- `post` has the write token and no secret. It reads `review.json` as data. If GitHub refuses a line comment, every finding goes in the summary. @-mentions in the model's text are broken, so a review notifies no one.
- **Whose script runs:** on a comment's or on-demand run, main's (GitHub starts those from main), and the PR's head is only read, by SHA. On a push or a label, the PR's own, as for the tests: a fork PR gets no secret, and a branch in the repo could change the workflow itself anyway.

Set up once: the repository secret `GEMINI_API_KEY`, the label `review`, and optionally the variable `GEMINI_MODEL`. Without it the review uses `gemini-3.8-flash`, one model for every request (Gemini CLI's own routing between models is off); locally, set `GEMINI_MODEL` the same way. The model gets the diff in its prompt, and 8 tool calls to read files, the diff's files first; a hook (`test/ci-review-budget.js`) refuses later calls, and it answers. A review that runs over 12 minutes is stopped, with everything it started.
