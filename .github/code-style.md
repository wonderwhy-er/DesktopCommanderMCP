# Code style

Write for the next reader. Each rule has a good and a bad example from our own code.

1. **Before you write a helper, look for one; after you write a copy, make it a helper.**
   Good: `return createErrorResponse(errorMessage)` (`src/handlers/filesystem-handlers.ts:387`); tests use `test/helpers/` (`createTestEnv`, `createTempDir`, `waitUntil`).
   Bad: 48 hand-written `{ content: [...], isError: true }` answers next to it (`src/handlers/search-handlers.ts:43`); the 4th copy of the telemetry stub (#937 `test/test-stalled-folder-lookups.js:50`).

2. **A function does one step and fits on a screen (about 50 lines). Split a long function before you add to it.**
   Good: `programName`, 6 lines (#939 `src/utils/shell.ts:199`).
   Bad: `handleCallToolRequest`, 345 lines (`src/server.ts:1205`); #944 adds 12 lines inside the 112-line `startProcess` (`src/tools/improved-process-tools.ts:145`).

3. **Return early; at most 3 levels of `if`/loop/`try` inside a function.**
   Good: reject at once, then the main path at one level (#937 `src/tools/filesystem.ts:472`).
   Bad: `setConfigValue`, 7 levels deep (`src/tools/config.ts:137`).

4. **No copied blocks.** The second copy of 5+ lines becomes a function both use.
   Good: #951's shared test helpers, which replaced the tests' own copies (`test/helpers/test-env.js:19`, used by 16 test files).
   Bad: 45 lines the same in `setup-claude-server.js:125` and `uninstall-claude-server.js:83`.

5. **One way to handle each kind of error.** Tools answer with `createErrorResponse`.
   Good: `return createErrorResponse(errorMessage)` (`src/handlers/filesystem-handlers.ts:387`).
   Bad: a hand-written `{ content: [...], isError: true }` answer (`src/tools/improved-process-tools.ts:129`).

6. **A `catch` that ignores an error names the failure it expects and why ignoring it is safe.**
   Good: `// /proc/1/cgroup might not exist` (`src/utils/system-info.ts:128`).
   Bad: `/* best effort */` (`src/remote-device/remote-channel.ts:481`); `// Ignore detection errors` (`src/utils/capture.ts:340`).

7. **Comments say why, never what.** Don't restate the code or the function's name.
   Good: "In the Docker image Chromium can't start its sandbox …" (#946 `src/tools/pdf/markdown.ts:807`).
   Bad: `// Write new data` (`src/utils/files/excel.ts:246`); `/** Reads a command for cmd */` above `readCmdCommands` (#939 `src/utils/cmd-commands.ts:192`).

8. **Names say what the value is.** No `data`, `result`, `res`, `tmp`, `obj` or `info`, and no single letters outside a short loop or a one-line callback.
   Good: `stillLoadingError` (`src/utils/files/factory.ts:168`); `terminationFailedResult` (`src/tools/improved-process-tools.ts:29`).
   Bad: `const result: string[] = []` for the lines read (`src/utils/files/text.ts:442`).

9. **No nested ternaries.** Use `if … return`, a `switch`, or a lookup table.
   Good: `switch (platform)` (`src/utils/open-browser.ts:24`).
   Bad: `rules.longPairs?.includes(name) ? 2 : rules.long?.includes(name) ? 1 : 0` (#952 `src/utils/command-wrappers.ts:540`).

10. **One idea per line; no code line over 120 characters.**
    Good: one option per line (`src/handlers/search-handlers.ts:24`).
    Bad: three conditional spreads on one line (#953 `src/utils/command-wrappers.ts:647`).

11. **Don't pass a flag down through layers, and no bare `true`/`false`/`undefined` arguments.** Pass named options, or decide once and call the right function.
    Good: `startSearch({ rootPath, pattern, … })` (`src/handlers/search-handlers.ts:24`).
    Bad: `includeStatusMessage` handed through 5 readers with 8 positional parameters (`src/utils/files/text.ts:318`).

12. **Tests: one named `test()` per behaviour, and the name says the behaviour.**
    Good: `test('a logout while the device runs sticks: device.json is not written back', …)` (`test/integration/remote-device-restart.js:228`).
    Bad: a 515-line `runTests()` with numbered sections (`test/test-remote-report.js:76`); `// Test 3: backtick substitution` (#939 `test/test-blocklist-bypass.js:37`).

13. **Tests wait for the thing they check, not for a fixed time.** Use `waitUntil` (`test/helpers/wait.js`). A fixed wait is fine only when time is the behaviour under test, and the comment says so.
    Good: `await waitUntil(() => exited(pid), 10_000, 'the process exits')` (`test/test-process-exit.js:64`).
    Bad: `await sleep(800)`, then reading the session list (`test/repro/test-process-wait-client-cap.js:149`).
