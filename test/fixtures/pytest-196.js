/**
 * What pytest -v printed in #196, taken from the issue: the session header, then
 * "collecting ... " with no newline, which pytest ends only when collection is
 * done (start_process answered with "waiting for input (detected: "...")").
 * PYTEST_PROGRESS_LINE is the last progress line from the issue's expected run,
 * as it reads before its newline arrives. Only the reporter's project path was
 * replaced, with a neutral /Users/me/project; everything else is as reported.
 *
 * Run as a script, it prints PYTEST_COLLECTING and keeps running, as pytest does
 * while it collects; it ends on its own after LIFETIME_MS.
 */
import { isMainModule } from '../helpers/run-if-main.js';

const LIFETIME_MS = 15_000;

export const PYTEST_COLLECTING = "============================= test session starts ==============================\nplatform darwin -- Python 3.12.10, pytest-8.4.1, pluggy-1.6.0 -- /Users/me/project/.venv/bin/python3\ncachedir: .pytest_cache\nrootdir: /Users/me/project\nconfigfile: pyproject.toml\ntestpaths: tests\nplugins: asyncio-1.1.0, anyio-4.8.0, cov-6.2.1\nasyncio: mode=Mode.STRICT, asyncio_default_fixture_loop_scope=function, asyncio_default_test_loop_scope=function\ncollecting ... ";

export const PYTEST_PROGRESS_LINE = "tests/unit/test_utils.py F.F..                                                                                                                                                                                                                                                                                        [100%]";

if (isMainModule(import.meta.url)) {
  process.stdout.write(PYTEST_COLLECTING);
  setTimeout(() => {}, LIFETIME_MS);
}
