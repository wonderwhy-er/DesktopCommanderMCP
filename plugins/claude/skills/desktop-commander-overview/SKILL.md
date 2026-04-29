---
name: desktop-commander-overview
description: Use for Desktop Commander MCP capabilities — persistent shells and REPLs, long-running processes, filesystem beyond the workspace, structured files (.xlsx, .docx, .pdf, images) and large local data files such as CSVs, ripgrep search at scale, SSH, or cross-turn state.
---

# Desktop Commander MCP

Desktop Commander gives Claude Code reach across the user's actual computer — files, folders, terminals, processes, structured documents, and remote machines reachable over SSH. The tools' detailed schemas live in the MCP itself; this skill explains what they enable and how they compose into common workflows.

## What This MCP Gives Claude

**Persistent shell sessions.** Desktop Commander keeps a started process or session alive across tool calls. Inside a single long-lived shell, REPL, or SSH session, state carries forward — environment variables, working directory, activated virtualenvs, open connections, REPL variables — so Claude can `cd`, activate a venv, then send commands or code into that same session later without re-setup.

**Long-running processes.** Start a dev server, watcher, build, training run, or test suite in the background and keep working. The MCP returns a process handle Claude can tail, interact with, or terminate across many turns.

**Filesystem reach beyond the IDE workspace.** Read, write, move, list, and inspect files anywhere the user has granted scope. Useful for organize-and-clean tasks, batch document work, and files that do not fit inside an IDE sandbox.

**Surgical edits to existing files.** The `edit_block` tool does exact-string find-and-replace with safety checks. Prefer focused edits over rewriting whole files based only on the slice you happened to read.

**Binary and structured files handled directly by the MCP.** Excel, DOCX, PDF, images, and large local data files are supported through format-specific workflows instead of text-only approximations.

**Search at scale.** Streaming, ripgrep-backed search across whole projects or folder trees. Use filename search and content search to narrow large codebases without flooding context.

**Remote machines via SSH.** A long-lived SSH session inside a persistent shell lets Claude connect once, tail logs, run diagnostics, deploy, or debug across many turns without reconnecting each step.

## Example Workflows

### Debug a production issue

Use `start_process` to open an SSH session, `interact_with_process` to run commands such as `tail -f`, `read_process_output` to inspect new output, and `force_terminate` when the session is done.

### Run a dev server and iterate

Use `start_process("npm run dev", timeout_ms=...)` to keep the server running. Edit code, read server output, run one-shot checks such as `curl`, and repeat without restarting the server each turn.

### Refactor across a monorepo

Use `start_search` to find call sites, `get_more_search_results` to page through results, `read_multiple_files` for context, and `edit_block` for focused changes. Re-run the search before considering the refactor complete.

### Work with spreadsheets and reports

Use `read_file` with sheet and range options for Excel, `edit_block` with Excel ranges for cell updates, DOCX outline/XML reads for report edits, and `write_pdf` for creating or modifying PDFs.

### Analyze a large CSV

Start a Python REPL with `start_process("python3 -i", timeout_ms=...)`, load the dataframe once, then use `interact_with_process` for follow-up questions without reloading the file.

## Core Tool Inventory

- **Process / shell:** `start_process`, `interact_with_process`, `read_process_output`, `list_processes`, `list_sessions`, `kill_process`, `force_terminate`
- **Files:** `read_file`, `read_multiple_files`, `write_file`, `edit_block`, `write_pdf`
- **Filesystem:** `list_directory`, `get_file_info`, `move_file`, `create_directory`
- **Search:** `start_search`, `get_more_search_results`, `list_searches`, `stop_search`
- **Diagnostics / config:** `get_recent_tool_calls`, `get_config`

## Conventions

Prefer absolute paths. File operations only work inside the user's configured `allowedDirectories`. Long outputs support pagination with `offset` and `length`; use these instead of dumping huge outputs into context.
