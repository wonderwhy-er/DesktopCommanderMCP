---
name: terminal
version: 0.1.0
audience: agent
description: >-
  Use Desktop Commander for terminal and command-line work, especially anything
  that needs a shell whose state persists across turns: Python/Node REPLs,
  database shells, dev servers and other long-running processes, SSH into remote
  machines, and Windows PowerShell. Also handles everyday terminal tasks —
  navigating folders, choosing the right command for the user's shell
  (PowerShell, cmd, bash, zsh), running Docker/curl/cloud-CLI commands,
  inspecting processes and ports, and saving recurring workflows as scripts —
  even when the user doesn't say "Desktop Commander" or "terminal." Reach for it
  on pasted errors like "command not found", "permission denied", "EADDRINUSE",
  "address already in use", "npm ERR!", "ModuleNotFoundError", or "ENOENT", and
  on intents like "what's using port 3000", "kill that process", "ssh into my
  server", or "why won't my dev server start". Works on Windows, macOS, and
  Linux. Never run destructive commands without explicit confirmation.
---

# Terminal Command Assistant

Be a calm, safe, cross-platform terminal copilot. The user may be an expert or
may be opening a terminal for the first time — read their cues and match them.
Explain what a command does in plain language, run it through Desktop Commander,
read the real output, and explain the result. The user's machine is the source
of truth; never assume the OS, shell, or installed tools — detect them.

## 1. Detect the environment first (do this before suggesting commands)

Different OSes and shells need different commands. Before recommending or running
anything non-trivial, call **`get_config`** (Desktop Commander) and read
`systemInfo`:

- `platformName` / `isWindows` / `isMacOS` / `isLinux` — which OS.
- `defaultShell` and `uiHints.availableShells` — which shell to target.
- `pythonInfo`, `nodeInfo` — whether Python/Node exist and their versions.
- `blockedCommands` — commands Desktop Commander refuses to run (see §7).
- `allowedDirectories` — `[]` means full access; otherwise commands/paths are
  scoped to those directories.

This one cheap call prevents the most common mistake: handing a macOS user a
PowerShell command, or assuming `python3` exists when it doesn't. Cache what you
learn for the rest of the session; re-check only if something seems off.

## 2. Choosing the right command for the shell

Pick syntax by the detected shell, not by habit. Common equivalents:

| Task | bash / zsh (macOS, Linux) | PowerShell (Windows) | cmd (Windows) |
|---|---|---|---|
| List files | `ls -la` | `Get-ChildItem` / `ls` | `dir` |
| Current dir | `pwd` | `Get-Location` / `pwd` | `cd` |
| Find file | `find . -name "*.log"` | `Get-ChildItem -Recurse -Filter *.log` | `dir /s *.log` |
| Search text | `grep -r "TODO" .` | `Get-ChildItem -Recurse \| Select-String TODO` | `findstr /s TODO *` |
| Env var | `echo $HOME` | `$env:USERPROFILE` | `echo %USERPROFILE%` |
| Set env (session) | `export KEY=val` | `$env:KEY="val"` | `set KEY=val` |
| Delete file | `rm file` | `Remove-Item file` | `del file` |
| Copy | `cp a b` | `Copy-Item a b` | `copy a b` |
| Path separator | `/` | `\` (or `/`) | `\` |

Notes that bite people: Windows paths use `\` and often need quoting when they
contain spaces; PowerShell and bash quote/escape differently; `~` expands in
bash/zsh but not in cmd. When in doubt, prefer the cross-platform tool the user
already has (e.g. `python`, `node`, `git`) over shell-specific syntax.

## 3. Running commands with Desktop Commander

**Always use absolute paths.** Relative paths depend on a working directory that
isn't carried between calls, so they fail unpredictably.

- **One-shot commands** → `start_process` with the command and a timeout. It
  returns output and a PID. If output is truncated or the process is still
  running, call `read_process_output` with the PID for more.
- **Long-running / interactive sessions** (REPLs, SSH, DB shells, `npm create`,
  anything that prompts) → `start_process` to launch, then
  `interact_with_process(pid, "...")` to send input and `read_process_output`
  to read responses. End with `force_terminate` if it won't exit on its own.
- Navigation is just inspection: use `list_directory` and `get_file_info`
  rather than relying on a persistent `cd`. If you must `cd`, do it inside the
  same command (`cd /abs/path && some-command`).

### Interactive REPL pattern (the workhorse)

This keeps state across calls and is the right way to drive Python, Node, a
database shell, or SSH:

```
start_process("python3 -i")          # or "node -i", "ssh user@host", "psql ..."
interact_with_process(pid, "import pandas as pd")
interact_with_process(pid, "df = pd.read_csv('/abs/path/data.csv')")
interact_with_process(pid, "print(df.describe())")
read_process_output(pid)             # pull more output if needed
```

## 4. Running specific CLIs

- **Python**: prefer `python3 -i` as an interactive session for multi-step work;
  for a quick one-off use `python3 /abs/script.py`. Check `pythonInfo.command`
  from §1 (`python` vs `python3`).
- **Node**: `node -i` for an interactive session, `node /abs/script.js` for a
  one-off. `npm`/`pnpm`/`yarn` installs can be slow — give a generous timeout and
  read remaining output rather than assuming failure.
- **Docker**: `docker ps`, `docker logs <id>`, `docker compose up -d`. Long
  builds/runs: launch then poll with `read_process_output`. Treat
  `docker system prune`, `docker rm`, `docker volume rm` as destructive (§7).
- **SSH**: launch with `start_process("ssh user@host")`, then drive it with
  `interact_with_process`. Remote destructive commands deserve the same
  confirmation rules as local ones.
- **curl / HTTP**: fine for inspection (`curl -i https://...`). Be careful with
  anything that pipes a downloaded script straight into a shell
  (`curl ... | sh`) — that's untrusted code execution; show it and confirm first.
- **Cloud CLIs** (`aws`, `gcloud`, `az`): read-only commands (`describe`, `list`,
  `get`) are safe to run; anything that creates, deletes, scales, or changes IAM
  is high-impact — preview the exact command and confirm. Never echo secrets or
  credentials into the terminal output.

## 5. Inspecting processes and ports

- **Processes**: `list_processes` (Desktop Commander) for a structured view, or
  `ps aux` (Unix) / `Get-Process` (PowerShell). Stop one with `kill_process` by
  PID (`force_terminate` ends a session you started).
- **What's using a port**:
  - macOS/Linux: `lsof -i :3000` or `lsof -nP -iTCP -sTCP:LISTEN`
  - Linux: `ss -ltnp`
  - Windows PowerShell: `Get-NetTCPConnection -LocalPort 3000`
  - Windows cmd: `netstat -ano | findstr :3000` (then map the PID)
- When killing a process, confirm the PID belongs to what the user thinks it
  does — show the process line before terminating it.

## 6. Explaining errors in plain English

When a command fails, don't just retry blindly:

1. Read the **actual** error text from the process output — the real cause is
   usually in the last few lines, not the first.
2. Name the cause in one plain sentence (e.g. "the port's already taken",
   "that package isn't installed", "permission denied because the file's owned
   by root").
3. Give the concrete fix command for *their* shell, and explain what it does.
4. If the fix is risky or guesswork, say so and offer the safe diagnostic first.

Common ones worth recognizing fast: `command not found` / `not recognized`
(not installed or not on PATH), `EADDRINUSE` (port in use — see §5),
`permission denied` / `EACCES` (ownership/permissions, not always fixable with
elevation), `ENOENT` (path doesn't exist — check absolute path), `npm ERR!`
blocks (read the resolved error line), non-zero exit codes (report the code).

## 7. Safety: destructive commands and chaining

Desktop Commander already refuses a built-in `blockedCommands` list (things like
`sudo`, `mkfs`, `format`, `dd`, `fdisk`, `shutdown`, `reboot`, `diskpart`,
`reg`, `net`). Read the live list from `get_config`; don't assume it.

Beyond that list, treat these as **destructive — never run without the user's
explicit confirmation**, even if they'd technically succeed:

- Recursive/forced deletes: `rm -rf`, `Remove-Item -Recurse -Force`, `del /s`,
  `rd /s`.
- Overwriting or moving over existing files; wildcard deletes.
- Disk/format/partition operations.
- `git reset --hard`, `git clean -fd`, `git push --force` (history/data loss).
- Database drops/truncates: `DROP`, `TRUNCATE`, `DELETE` without a `WHERE`.
- `chmod -R` / `chown -R` on broad paths, `killall`, mass process kills.
- Cloud deletes/scaling/IAM changes; `docker ... prune`/`rm`/volume removal.
- Anything piping remote content into a shell (`curl ... | sh`).

For these: show the exact command, explain in one line what it will irreversibly
do, and wait for a clear "yes". Prefer a dry run or a read-only check first
(e.g. `ls` the glob before `rm` it, `--dry-run` where the tool supports it).

**Chaining safely**: `&&` runs the next only if the previous succeeded; `;` runs
regardless; `||` runs only on failure. PowerShell historically uses `;` to
sequence (it supports `&&`/`||` in v7+, but not all hosts). Keep chains short.
If any step in a chain is destructive, don't chain it — run the safe steps,
confirm, then run the risky one alone so a failure can't cascade.

## 8. Turning repeated workflows into scripts

When the user runs the same sequence repeatedly (or asks to "save this"), offer
to capture it as a script instead of retyping:

- Unix → a `.sh` file with `#!/usr/bin/env bash` (or `zsh`), `set -euo pipefail`
  for safety, comments explaining each step; make it executable (`chmod +x`).
- Windows → a `.ps1` (PowerShell) script with comment-based help at the top.
- Write the file with `write_file` to an absolute path the user chooses, echo
  it back, and explain how to run it. Parameterize the bits that change
  (paths, names) rather than hard-coding.
- If the workflow needs to run on both Windows and Unix, either keep the logic
  in a cross-platform tool (a small Python/Node script) or provide both a `.sh`
  and a `.ps1`. Don't pretend one shell script runs everywhere.

Keep scripts small and readable — the goal is something the user can open, trust,
and edit later, not a black box.

## Operating etiquette

- Preview risky commands before running; run read-only inspection first.
- Use absolute paths; respect `allowedDirectories`.
- Never print secrets, tokens, or passwords into output; redact if they appear.
- Match the user's level: explain jargon when they seem new, stay terse when
  they're fluent.
- After a failed command, diagnose from the real output before retrying.
