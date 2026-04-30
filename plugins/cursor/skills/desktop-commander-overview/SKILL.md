---
name: desktop-commander-overview
description: Use for Desktop Commander MCP capabilities — persistent shells and REPLs, long-running processes, filesystem beyond the workspace, structured files (.xlsx, .docx, .pdf, images) and large local data files such as CSVs, ripgrep search at scale, SSH, or cross-turn state.
version: 0.1.0
audience: agent
---

# Desktop Commander MCP

Desktop Commander gives the agent reach across the user's actual computer — files, folders, terminals, processes, structured documents, and remote machines reachable over SSH. The tools' detailed schemas (parameters, return shapes, format-specific behavior) live in the MCP itself; this skill explains what they enable and how they compose into common workflows.

## What this MCP gives the agent

**Persistent shell sessions.** Desktop Commander keeps a started process or session alive across tool calls. Inside a single long-lived shell, REPL, or SSH session, state carries forward — environment variables, working directory, activated virtualenvs, open connections, REPL variables — so the agent can `cd`, activate a venv, then send commands or code into that same session many turns later without re-setup. (Note: separate `start_process` calls open separate sessions and do **not** share shell state with each other; persistence is inside one session, not across them.)

**Long-running processes.** Start a dev server, watcher, build, training run, or test suite in the background and keep working. The MCP returns a process handle the agent can tail, interact with, or terminate across many turns. Long-running commands don't need to block the workflow waiting for a foreground command to exit.

**Filesystem reach beyond the IDE workspace.** Read, write, move, list, and inspect files anywhere the user has granted scope — Downloads, Documents, project folders outside the IDE, or any other granted folders. Useful for organize-and-clean tasks, batch document work, and any "look at the file my coworker just sent me" request that doesn't fit inside the IDE sandbox.

**Surgical edits to existing files.** The `edit_block` tool does exact-string find-and-replace with built-in safety: ambiguous matches fail loudly instead of silently overwriting the wrong thing, and an `expected_replacements` count prevents partial-match disasters. Lower data-loss risk than rewriting whole files based on the slice you happened to read — though a wrong `old_string` or wrong `expected_replacements` can still corrupt content, so review the changed content before considering the edit done.

**Binary and structured files handled directly by the MCP.** Excel, DOCX, and PDF are first-class — read and modified through format-specific mechanisms rather than text-only approximations: Excel via cell-range JSON, DOCX via raw-XML edits, PDF via page-level operations on a new output file. The result is the real file in its original format, not a regenerated approximation. Images and PDFs return as viewable content for the agent.

**Search at scale.** Streaming, ripgrep-backed search across whole projects or folder trees. The agent picks between filename search and in-file content search, pages through results progressively without flooding context, and runs multiple concurrent searches when the query is ambiguous.

**Remote machines via SSH.** A long-lived SSH session inside a persistent shell turns the agent into a real ops tool: connect once, then tail logs, run diagnostics, deploy, or debug across many turns without reconnecting each step.

**Process management.** List, inspect, tail, and kill accessible processes (subject to OS permissions). Useful for cleaning up stale dev servers from previous sessions and for diagnosing CPU / memory issues.

## Example workflows

Each example names the actual tool sequence. Calls below are written in pseudocode shorthand (`tool_name("arg", flag=value)`); the real tools take object-shaped arguments. Tool descriptions and full parameter sets live in the MCP itself.

### "Debug this production issue"

Before running production-impacting SSH commands, explain the intended action and get user confirmation when the risk is non-trivial.

`start_process("ssh user@prod.example.com", timeout_ms=...)` opens a long-lived SSH session and returns a PID. `interact_with_process(pid, "tail -f /var/log/app.log\n")` starts streaming logs. Subsequent turns: `read_process_output(pid, offset=-50)` to see the last 50 lines as they arrive, `interact_with_process(pid, "...")` to run diagnostic commands in the same session. `force_terminate(pid)` to close the session when done — for sessions opened by `start_process`, `force_terminate` is the correct cleanup tool; `kill_process` is for arbitrary OS PIDs found via `list_processes`.

### "Deploy this to staging"

Before deploys, restarts, migrations, or other environment-changing commands, summarize the action and confirm with the user unless they already explicitly asked for that exact operation.

`start_process` for the deploy command (could be a script, an SSH-piped command, or `kubectl`/`gh` etc.). `read_process_output` to track output and surface errors. If the deploy needs an interactive confirmation, `interact_with_process(pid, "yes\n")`. The session stays alive while the agent watches for completion or rollback.

### "Run the dev server and iterate on the API"

`start_process("npm run dev", timeout_ms=...)` keeps the server up. The agent then loops: `edit_block` on the route file, `read_process_output(pid, offset=-30)` to see the server's reload, `start_process("curl -s http://localhost:3000/api/...")` for a one-shot test, repeat. The dev server never has to restart between code changes.

### "Refactor across this monorepo"

`start_search(pattern="oldFunctionName", path=repo_root, searchType="content")` scopes every call site. `get_more_search_results(sessionId)` pages through. `read_multiple_files(paths=[...])` confirms ambiguous hits in context. `edit_block(file_path, old_string, new_string)` per site, with `expected_replacements` set when the same substring legitimately appears multiple times in one file. Verify by re-running `start_search` on the old name and paging the results with `get_more_search_results(sessionId)` until the run completes — only then can you confirm zero remaining hits.

### "Update the Q3 numbers in this spreadsheet and tweak the summary in the report"

`read_file(path="/.../q3.xlsx", sheet="Revenue", range="A1:F50")` returns the existing numbers as a JSON 2D array. `edit_block(file_path="/.../q3.xlsx", range="Revenue!C12:C24", content=[[12345], ...])` updates the cells in place. For the report, DOCX editing is a two-read flow: first `read_file(path="/.../report.docx")` (offset 0) returns the document's outline (headings + paragraph text) so you can locate the summary section. Then `read_file(path="/.../report.docx", offset=N, length=...)` with **`N > 0`** returns the raw underlying XML around that section — a non-zero offset is what flips the read into XML mode. Copy an XML fragment from that output as `old_string` and call `edit_block(file_path, old_string, new_string)` with the rewritten XML. The user gets back real `.xlsx` and `.docx` files, not regenerated approximations.

### "Generate the Q3 report as a PDF"

Compose markdown content (header, table, charts via embedded HTML), then call `write_pdf` to render it to a new PDF file. The MCP's `write_pdf` tool description specifies the exact parameters and filename rules — follow that.

### "Insert a cover page into this PDF"

`write_pdf` also supports modifying existing PDFs via an operations array (insert / delete pages). Use it for existing-PDF edits that produce a new PDF — adding a cover page, removing a section, merging in content from another file. See the `write_pdf` tool description for the operation shapes and parameter rules.

### "Analyze this 200MB CSV"

`start_process("python3 -i", timeout_ms=...)` opens a Python REPL and returns a PID. `interact_with_process(pid, "import pandas as pd; df = pd.read_csv('/abs/path.csv')")` loads it once. Every subsequent question — `df.describe()`, `df.groupby('col').size()`, plot a chart — runs in the same already-loaded REPL. Libraries don't re-import, the dataframe doesn't re-load. The MCP itself recommends this workflow for any local data-file analysis.

### "Run a quick Node script"

`start_process("node:local", timeout_ms=...)` opens a stateless Node execution mode on the MCP server itself — ES imports supported. `start_process` opens the runner; each piece of JS is sent via `interact_with_process(pid, "<your JS here>")` and runs independently (no shared state between calls). Good for one-shot transformations where keeping a long-lived REPL alive isn't worth it. Don't try to put code into the `start_process` command argument — only the runner type (`node:local`) goes there.

### "Explain this codebase"

`list_directory(path=repo_root, depth=3)` for shape. `start_search(pattern="export ", path=repo_root, searchType="content")` to find the public surface. `read_multiple_files(paths=[entrypoints])` for the actual code. The agent can keep narrowing without re-asking the user where to look.

### "Organize my Downloads folder"

Resolve the path to absolute first (e.g., `/Users/<user>/Downloads`, not `~/Downloads`). Then `list_directory(path="/Users/<user>/Downloads", depth=1)` to see what's there. `start_search(pattern="*.pdf", path="/Users/<user>/Downloads", searchType="files")` and similar for other types. `create_directory` for new folders. `move_file` per item. Preview the move plan before executing destructive ops.

### "Onboard me — what was happening last session?"

`get_recent_tool_calls(maxResults=200)` returns recent activity with arguments and outputs. `list_sessions` shows still-running terminal sessions. `list_searches` shows in-flight searches. `list_processes` shows what's still alive. Together they reconstruct the work without asking the user to recap.

### "Why isn't the REPL responding?"

`list_sessions` — if `Blocked: true`, the REPL is waiting for input rather than hung. `read_process_output(pid, offset=-100)` to see what it last printed (often a prompt). `interact_with_process(pid, "<the input it's waiting for>\n")` unblocks it.

## Core tool inventory

Grouped index of the tools an agent reaches for most often. Not exhaustive — the MCP exposes additional config / diagnostics / feedback tools beyond this list. Detailed parameters and return shapes for every tool are in the MCP's own tool descriptions.

- **Process / shell:** `start_process`, `interact_with_process`, `read_process_output`, `list_processes`, `list_sessions`, `kill_process`, `force_terminate`
- **Files (read/write):** `read_file`, `read_multiple_files`, `write_file`, `edit_block`, `write_pdf`
- **Filesystem:** `list_directory`, `get_file_info`, `move_file`, `create_directory`
- **Search:** `start_search`, `get_more_search_results`, `list_searches`, `stop_search`
- **Diagnostics / config:** `get_recent_tool_calls`, `get_config`

## Conventions

**Prefer absolute paths.** Relative paths may fail depending on the working directory, and tilde paths (`~/...`) may not expand in all contexts. Absolute paths are the most reliable; pass them whenever you can.

**Allowed-directory scope.** File operations only work inside the user's configured `allowedDirectories`. Expect `[DENIED]` markers in `list_directory` output and rejections from `read_file` / `write_file` when the path is out of scope. Surface the rejected path to the user — don't retry.

**When running on macOS:** default shell is zsh. Use `python3` not `python`. Some GNU tools have prefixed names (`gsed` for GNU sed). `brew` is the typical package manager. `open` opens files / apps from the terminal, `mdfind` is the fastest path to exact-filename search via Spotlight. Detect the host platform via `get_config` (or by inspecting `process.platform` / `uname` from a shell) before assuming any of the above — Windows and Linux hosts behave differently.

**Pagination.** Long outputs (file reads, process output, search results) all support `offset` and `length`. Negative offsets read from the end (tail mode). Use these instead of dumping huge results into context.
