---
name: ai-tools-setup
version: 0.1.0
audience: agent
description: >-
  Set up, connect, validate, and repair Claude Desktop and MCP servers using
  Desktop Commander — inspecting and fixing mcp.json / claude_desktop_config.json,
  getting MCP servers to connect, and diagnosing local AI tooling. Use when a
  user wants to install, configure, connect, validate, or fix Claude Desktop, an
  MCP server, an MCP config file, or a local AI agent/gateway. Trigger on the
  symptoms that actually bring people in: "Claude can't see my tools", "my MCP
  server isn't showing up", "tools aren't loading in Claude", "add an MCP
  server", "my MCP isn't connecting", "fix my Claude Desktop config", "the agent
  won't respond", "wire up Ollama / LM Studio", "restart Claude Desktop". Also
  covers local agent gateways like OpenClaw and Hermes.
---

# AI Tools Setup Assistant

Help users install, configure, and repair AI tooling on their own machine using
Desktop Commander's file and terminal tools. The work is usually
**configure-and-troubleshoot**, not clean installs — assume something already
exists and may be half-broken.

## Golden rules (read before doing anything)

1. **Detect the OS and shell first.** Read `get_config` and use its `systemInfo`
   and `allowedDirectories` — file paths, commands, and config locations differ
   across macOS, Windows, and Linux, so confirm the platform before assuming
   anything.
2. **Verify the model/API key works before you build.** The most common reason
   these sessions dead-end is a provider auth or billing error discovered
   *after* a lot of setup work. Make one tiny test call with `start_process` (a quick
   curl to the provider) early, and tell the user plainly if the key is invalid
   or out of credit.
3. **Translate errors, don't dump them.** When a tool returns a raw JSON/HTTP
   error, explain in one line what it means and what to do next. If a model is
   missing, deprecated, rate-limited, or doesn't support tool-calling, suggest a
   concrete working alternative instead of retrying the same thing.
4. **Never echo secrets.** API keys, tokens, and passwords go *into the right
   config or `.env` file* — never repeated back in chat. If a user pastes a live
   secret, warn them, use it, and suggest they rotate it if it was shared
   insecurely. Redact secrets in any output, logs, or summaries you produce.
5. **Back up before you edit.** Copy the config to a `.bak` first with
   `start_process` (`cp file.json file.json.bak`, or `copy` on Windows), then make
   the change with `edit_block` so existing entries survive — reach for
   `write_file` only on a from-scratch config. Validate the JSON after every edit
   by parsing it with `start_process`.
6. **Verify, then stop.** After a change, actually confirm it worked — use
   `list_processes` to confirm the process is running and `start_process`
   (`lsof`/`netstat`) to confirm the port is listening, then check the client
   reconnected and its tools are listed. Don't declare success on a guess.
7. **Make it repeatable.** Once something works, offer to save the steps as a
   short note or script so the user can redo it later.

## What this skill covers

This skill routes to one of three reference files depending on the task. Read
the relevant file before acting — they contain the exact paths, commands, and
known failure modes.

- **Claude Desktop & MCP servers** — installing Claude Desktop, adding MCP
  servers, and inspecting / validating / repairing MCP config files
  (`claude_desktop_config.json`, `.claude/mcp.json`, `~/.lmstudio/mcp.json`,
  and similar). Also connection health checks.
  → Read `references/claude-desktop-mcp.md`

- **OpenClaw** — a self-hosted multi-channel gateway for AI agents. Install,
  onboard, wire a model/provider, connect channels (Telegram, Slack, iMessage,
  etc.), diagnose the gateway, and uninstall.
  → Read `references/openclaw.md`

- **Hermes** — disambiguate first: **Hermes Agent** (the Nous Research
  self-improving agent framework) vs. **Hermes 3** (just a local LLM you run via
  Ollama). Install, run `hermes setup --portal`, configure providers, personality
  (`SOUL.md`), memory/skills, MCP, and messaging.
  → Read `references/hermes.md`

When in doubt about a tool's current behavior, fetch the official docs:
OpenClaw — https://docs.openclaw.ai/ ·
Hermes — https://hermes-agent.nousresearch.com/docs/

## General workflow

1. **Clarify the goal and platform.** Install vs. configure vs. fix? Which OS?
   Which tool/client?
2. **Inspect current state.** `read_file` the relevant config files and use
   `list_processes` to check whether the relevant process/port/service is already
   running before changing anything.
3. **Read the matching reference file** for exact paths and commands.
4. **Make the smallest change that moves forward**, backing up configs first.
5. **Verify** the result concretely.
6. **Summarize** what changed, where, and how to undo it — with secrets redacted.

## A generic "my agent isn't responding" diagnostic

Use this order for OpenClaw, Hermes, or any local agent/gateway:

1. **Provider/auth** — is a valid API key configured for the active provider,
   and does it have credit? (Most failures stop here.)
2. **Model** — does the chosen model exist, and does it support tool-calling?
   Local models especially often don't.
3. **Process/port** — is the gateway/daemon actually running and listening on
   its port? Is another process holding that port?
4. **Connection** — for chat clients/websockets, does it connect but drop on
   first message? That usually points back to provider/model, not networking.
5. **Logs** — read the tool's logs for the first real error, not the last one.
