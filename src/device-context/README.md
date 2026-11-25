# Persistent device context (prototype)

A new chat with Desktop Commander (DC) knows nothing about the computer it is on. To answer "my shop is down" it
either explores the disk (`ls`, `find`, reading files) or asks the user where things are. DC's only memory so far was
`get_recent_tool_calls`, which returns raw JSON of past calls: tens to hundreds of thousands of characters.

This prototype gives DC a small memory of the device, like an `AGENTS.md` for the whole computer:

- it **records** which project folders DC tool calls touched, what was edited, which commands ran and whether they failed;
- it **keeps** that across restarts in a local file;
- it **gives** a fresh agent session a short summary (about 240 tokens on average, up to ~600 for a heavy user) of recent work, through a tool or as a note on the
  first exploring call;
- it **compacts** `get_recent_tool_calls` to one line per call.

The memory stays on the device. File contents, command arguments and secrets are never stored. The only thing sent
anywhere is DC's usual anonymous telemetry (event counts and sizes, no paths), which is off when DC telemetry is disabled.

Code: `src/device-context/` (`core.ts`, `card.ts`, `index.ts`, `nudge.ts`, `machine.ts`), wired into `src/server.ts`.
Tests: `test/device-context/`.

---

## Quick start

```bash
npm install
npm run build
```

Turn the feature on with one of:

- a mode file (read once when DC starts; wins over the env var):
  `~/.claude-server-commander/device-context-mode` containing `both`
- the env var `DESKTOP_COMMANDER_DEVICE_CONTEXT=both` in the MCP server config.

Modes: `off` (default) · `tool` (only the `get_device_context` tool) · `nudge` (only the note, for clients that do not
list new tools, e.g. ChatGPT via remote) · `both`.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dc-fork": {
      "command": "node",
      "args": ["C:\\dev\\DesktopCommanderMCP\\dist\\index.js"],
      "env": { "DESKTOP_COMMANDER_DEVICE_CONTEXT": "both" }
    }
  }
}
```

Claude Desktop keeps a server's env from when the server was first added and does not re-read later config edits, even
after a restart. That is why the mode file exists: to switch modes, write the file and restart Claude Desktop.
`test/device-context/claude-desktop-setup.ps1 [-Mode both|off]` does all of it (build, break the test shop, write the
config and the mode file).

On first start with the feature on, DC builds the memory from its existing `tool-history.jsonl`, so recent work is
known from the first chat.

---

## What the agent gets

### `get_device_context` (new tool)

Description shown to the model: *what was recently worked on on this computer… Call it first when the user talks about
their projects, sites or apps ("my site", "the app", "continue where we left off"), before listing or searching
directories.*

- no arguments: the summary card (below);
- `project` (name or path): details for one project;
- `limit` (1–20, default 5): how many projects.

Example (real output from a test run, shortened):

```
💡 Recent work on this device, from Desktop Commander's record of earlier sessions; it may be out of date (now 2026-11-23 16:51 UTC, server tz UTC). Check the files before relying on it.
Last session: 2026-11-22 16:51 UTC–16:51 UTC: `C:\dev\travel-blog` — edited `posts/porto.md`
Projects (last session first, then most active):
1. `C:\dev\travel-blog` — `travel-blog: Personal travel blog` · Node · no git · last change 2026-11-22 16:51 UTC `posts/porto.md`
2. `C:\dev\handmade-shop` — `handmade-shop: Online store for handmade ceramics` · Node · no git · last run failed: `node` (2026-11-21 16:51 UTC) · last change 2026-11-21 16:51 UTC `.env`
3. `C:\dev\shop-old` — `shop-old: Archived copy of the old shop` · Node · no git · last active 2026-11-13 16:50 UTC
More per project is available from get_device_context with project set to its path.
```

Per project the card can show: description (README / manifest), stack, git branch and uncommitted changes, whether it
runs now (port → process → folder, Linux) or `NOT running now`, last changed file, last failed command. Plus:
other known projects by name, and recent work whose folder is gone (`Folder no longer found (renamed, moved or
deleted?)`).

### The note (for clients without the tool)

ChatGPT via remote DC sees a fixed tool list, so it cannot call `get_device_context`. In `nudge`/`both` mode the same
card is added **once per chat**, as its own text block **after** the tool's own output, to the first call that shows the
agent is looking for something:

- listing or searching a broad or system folder (`/`, home, `/var/www`, `C:\`…);
- a diagnostic command (`systemctl`, `ss -ltnp`, `docker ps`…);
- listing a folder that turns out empty (Claude Code's empty start folder);
- `get_config` (the "about this device" tool);
- `get_recent_tool_calls` (card on top of the history).

When the agent is already working inside a known project, nothing is added. When it searches for a name or opens a
missing path that matches a known project, a short targeted block names that project ("Did you mean…"). A "chat" is guessed
from the client's chat id when it sends one, otherwise from an idle gap (default 10 min,
`DESKTOP_COMMANDER_DEVICE_CONTEXT_EPISODE_MIN`).

### Compact history

In `nudge` and `both` modes, `get_recent_tool_calls` returns one line per call (time, tool, key argument, `ok` / `failed` /
`running`) instead of raw JSON. `format: "full"` returns the old raw output.

### `device-context.md` (the readable file)

`~/.claude-server-commander/device-context.md` holds the same facts as a Markdown file plus one line about the machine
(`Device: Windows_NT 10.0… · shell … · node v22… · home …`). It lists up to 10 projects (the card shows 5) and is rewritten at
most every 30 s after DC activity, and on every `get_device_context` call without `project`. Any agent or person can read it without calling a tool.

---

## How it works

```
tool call ──► server.ts ──► observeToolCall()           records facts ──► device-context-events.jsonl
                  │                                                         (journal, one JSON row per fact)
                  └────────► maybeAppendDeviceContext()  decides whether this call gets the card (nudge.ts)
                                    │
                                    ▼
                    readJournal() ─► rank() ─► renderCard() ─► note / tool result / device-context.md
```

1. **Observe** (`core.ts: observeEvent`). For each DC call: which file or folder it touched, which project root that
   belongs to, what kind (`read` / `edit` / `cmd`), the file name, and for commands an allow-listed verb (`npm test`,
   `git status`, `node`, `docker compose up`…). Global options are skipped (`git -C /p --no-pager log` → `git log`).
2. **Find the project root**: the enclosing git repository, else the nearest folder with a manifest (`package.json`,
   `pyproject.toml`, `go.mod`…), else a plain folder directly inside home or a known container (`~/code`, `~/sites`,
   `/var/www`, `C:\inetpub\wwwroot`…), or a site-like folder on Desktop/Documents. Without a marker, system folders,
   `AppData`, `Library`, caches and DC's own folder are never projects (a manifest inside them still counts).
3. **Failures**: DC's own exit-code line decides (if it is missing, an "exit code N" line or a crash pattern in the
   output), including exit codes that arrive later through `read_process_output`
   (linked by PID). A failure is recorded only when the verb's step is the only real step of the command line and
   nothing is piped (`npm test | grep FAIL` exits with grep's code). Ctrl-C and SIGTERM (130, 143) are stops, not
   failures.
4. **Journal**: `~/.claude-server-commander/device-context-events.jsonl`. Rows older than 90 days are ignored when
   read and removed when the file passes 1 MB and is compacted to one row per (day, project, kind, file, verb, failed).
5. **Rank** (`core.ts: rank`): per active day, 1 for real work (edits, builds, tests, scripts), 0.5 for looking (reads,
   `git status/log/diff`, `npm outdated`, `docker compose ps`…), times a recency multiplier. The last session's projects
   come first.
6. **Card** (`card.ts`): last session, up to 5 projects with facts, other projects by name. **Unfinished work** (something
   edited, then within a day a run failed, within 30 days) stays on the card even when other projects were busier, but
   never pushes out the last session's projects.

### Files

| File | What | Written by |
|---|---|---|
| `~/.claude-server-commander/device-context-events.jsonl` | the journal | every DC call (feature on) |
| `~/.claude-server-commander/device-context.md` | readable context | throttled, and on `get_device_context` |
| `~/.claude-server-commander/device-context-mode` | mode override | you / setup script |
| `~/.claude-server-commander/device-context-debug.jsonl` | decisions, sizes | only with `DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG=1` |
| `~/.claude-server-commander/tool-history.jsonl` | DC's existing history (source for the first build) | DC itself |

To forget everything: empty `device-context-events.jsonl` (do not delete it: a missing journal is rebuilt from
`tool-history.jsonl` on the next start) and delete `device-context.md`.

---

## Observed facts vs inferred intent, stale data, secrets

- **Only observed facts** go to the agent: folders used, files changed, verbs run, failed or not, what listens on which
  port, plus the project's own README title, manifest description and git remote.
  Nothing is guessed about what the user intends; the card says where the data comes from and that it "may be
  out of date. Check the files before relying on it".
- **Stale data**: every fact carries its time; `NOT running now` and git state are checked live when the card is built;
  folders gone within the last 14 days that had an edit or a failed run are reported as missing (at most 2; folders only
  read just drop off); rows older than 90 days are dropped.
- **Secrets**: no file contents (except a README title and manifest description), no command arguments, no environment
  values. `.env` is kept as a file name only.
  Paths, README titles and branch names are sanitized before they reach the card (they are a prompt-injection channel).

---

## Design decisions and tradeoffs

| Decision | Why | Tradeoff |
|---|---|---|
| A journal of facts, card built on demand | facts stay correct; the card reflects live state (running, git, missing folders) | building the card costs a few file reads and `git` calls |
| Card once per chat, not on every call | context on every call is duplication (Dmitry) | chat boundaries are guessed when the client sends no chat id |
| Note **after** the tool output, in its own block, in DC's 💡 style | text glued into file content or placed above it looks like prompt injection | the model may skim past it; tests show it is used |
| A tool **and** a note | Claude clients see new tools; ChatGPT via remote does not | two delivery paths to keep in sync |
| Compact `get_recent_tool_calls` | models call it on "yesterday we…"; raw JSON is huge | arguments and outputs are cut (`format: "full"` keeps them) |
| Allow-listed verbs only | never store full commands (secrets, tokens in arguments) | unknown tools (`magick`, `./run.sh`) are recorded as reads only |
| Mode file | Claude Desktop ignores env edits | one more place where config lives |
| No extra device inventory (disk, network, installed tools) | DC already reports OS, shell, Node, Python, Docker (`get_config`, tool descriptions); more inventory goes stale and costs tokens on every chat | bulk jobs that need disk space or tools still have to check |

---

## Tools changed

- **New**: `get_device_context`.
- **Changed**: `get_recent_tool_calls` — compact output and a `format` argument (`compact` is the default in `nudge` and
  `both` modes; `full` returns the raw output).
- **Unchanged**: all other tools. Their results may get the 💡 note once per chat.

---

## Results (summary)

Same broken shop in every shop test: a "previous chat" (real DC calls) changed `DATA_FILE` in `.env` to a missing file,
so the server crashes. Prompt: *"my online shop stopped working, can you fix it?"*

| Client / test | Without memory | With memory |
|---|---|---|
| Claude Code, chat from an empty temp folder (21–24 Nov) | 0 of 8 fixed (asks "where is your shop?") | 10 of 10 fixed |
| Claude Code, chat started next to the projects | 8 of 8, ~227k input tokens (median) | ~184k (−19%) |
| Claude Code, renamed shop folder (stale memory) | 3 of 3, ~267k | 3 of 3, ~193k (after the "folder no longer found" line; before it ~268k) |
| Claude Code, twin shop with the same description | — | 1 of 3 fixed, 2 of 3 asked which shop is real, 0 wrong edits |
| Claude Desktop (local DC) | 6 search calls before the shop | 0; first call `get_device_context` |
| ChatGPT via remote, finish a photo-resize job from a week ago | done; 3 history calls, ~1.1M chars | done; 2 history calls, ~33k chars (≈21× less for the same calls) |

Small samples (1–3 runs per variant). Raw logs are kept locally and not committed.

---

## Reproduce the demonstration

**Unit tests** (after `npm run build`):

```bash
node test/run-all-tests.js --no-build test-device-context.js   # also part of npm test
# or one suite at a time:
for f in test/device-context/device-context*.test.mjs; do node "$f"; done
node test/device-context/adversarial.test.mjs ./dist
node test/device-context/synthetic-eval.mjs ./dist
```

The `device-context*.test.mjs` suites pass on Linux and Windows (Linux-only checks are skipped on Windows).
`adversarial.test.mjs` is a list of attacks and edge cases, and the ones still open are printed as `FAIL` on purpose:
3 of 32 on Linux (macOS path case variants split one project; a second simultaneous chat without a chat id gets no
card; a heavy user's card is ~2,400 characters, over the 2,000 target), plus on Windows a `docker -v` volume path that
creates a false project root. `synthetic-eval.mjs` simulates 3 weeks of work (24 projects, 42 new sessions) and checks whether the card names the
project each new session works on: top-1 71% (same as "the last session's project"), on the card 79%; for projects
seen before, 100% on the card (the rest were brand-new projects memory cannot know). Card ≈ 240 tokens vs ≈ 21k for the
raw last 50 history calls. The workload is synthetic: this checks ranking behaviour, not real users.

**Claude Code, automated A/B** (Windows, PowerShell; needs `claude` in PATH; backs up and restores your DC files):

```powershell
$env:DC_DEV_TOOLS = '1'   # the eval, setup and VPS scripts are dev-only and refuse to run without it
powershell -ExecutionPolicy Bypass -File test\device-context\eval\run-eval.ps1 -Runs 3 -Arms "A,B,D,E,F,H,S,S0"
```

Arms: A no memory/empty folder · B no memory/next to projects · D memory · E note only · F path in prompt ·
H twin shop · S stale (renamed) · S0 stale without memory. Results: `test\device-context\eval\results\<time>\summary.md`
(per run: `claude.json` with every tool call, result, tokens and cost; `shop-status.txt` with the HTTP check).

**Claude Desktop** (manual):

1. `$env:DC_DEV_TOOLS = '1'; powershell -ExecutionPolicy Bypass -File test\device-context\claude-desktop-setup.ps1` (or `-Mode off`).
2. Quit Claude Desktop from the tray and open it again.
3. New chat, Remote Desktop Commander off, prompt: `use Desktop Commander: my online shop stopped working, can you fix it?`
   (without "use Desktop Commander" Claude Desktop uses its built-in file tools and never calls DC).
4. The calls are in `~/.claude-server-commander/tool-history.jsonl`.

**ChatGPT via remote DC** (Linux test machine running DC as a remote device): `test/device-context/photos/README.md`.

---

## Limitations

- Claude Desktop picks its built-in file tools unless the prompt names Desktop Commander.
- Memory is per device; it does not follow a project across computers.
- Command parsing is partial: `&&` inside quotes or `FOO=1 cmd` can leave a failure unrecorded, and with a single `&`
  (`npm test & curl localhost`) a failure can be blamed on the wrong verb.
- "Is it running" (port → folder) works on Linux only.
- Two projects that look the same on the card make the model ask instead of act.
- Ranking recency uses the last activity of any kind; a smoother per-day decay would be better.
- Two chats at the same time without a chat id: only the first gets the note.
- Tested on toy setups (3–4 projects locally, 13 on the test VPS) and a synthetic ranking test.

Code review (two rounds, 11 findings) — all addressed in this PR:

- `ss`, `docker ps` and `git status` run in the background (async `execFile`, cached 30 s / 60 s) and start when DC
  starts with the feature on, so building a card never blocks the server; the `/proc` fallback yields to the event loop.
- The suites run under the normal runner: `test/test-device-context.js` (part of `npm test`) runs every
  `test/device-context/device-context*.test.mjs` and the adversarial suite; known, documented gaps are reported with
  `skip()`, any other failure fails the run.
- The eval, setup and VPS scripts are marked dev-only and refuse to run unless `DC_DEV_TOOLS=1` is set; the ones that
  replace local DC files back them up first.
