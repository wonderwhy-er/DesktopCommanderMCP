# Hermes

**Disambiguate first — "Hermes" means two different things:**

1. **Hermes Agent** — the self-improving AI agent framework built by Nous
   Research (a learning loop that creates/improves skills, persistent memory,
   runs across many platforms). This is almost always what users mean when they
   say "set up Hermes." Docs: https://hermes-agent.nousresearch.com/docs/
2. **Hermes 3 (and other Hermes models)** — Nous Research's open-weight LLMs.
   "Set up Hermes 3" usually just means running a local model: `ollama pull
   hermes3` then `ollama run hermes3`. If that's the goal, treat it as ordinary
   local-model setup and stop here.

The rest of this file covers **Hermes Agent**. MIT licensed. For current
commands, fetch the docs (there's also `/docs/llms.txt` for a compact index).

## Install

**Desktop app (Windows/macOS):** download the Hermes Desktop installer from
https://hermes-agent.nousresearch.com/ and run it (installs CLI + desktop app).

**CLI only:**

```bash
# Linux / macOS / WSL2 / Android (Termux)
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

```powershell
# Windows (native), in PowerShell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

See the full Installation Guide for what the installer does, per-user vs. root
layout, and Windows notes.

## Fastest path to a working agent

```bash
hermes setup --portal
```

One OAuth via **Nous Portal** covers a model plus the four Tool Gateway tools
(web search, image generation, TTS, browser). This is the smoothest first run —
recommend it unless the user specifically wants their own provider keys.

## Providers & config

Hermes works with **Nous Portal, OpenRouter, OpenAI, or any compatible
endpoint**. Configuration lives in Hermes' config file (see the Configuration
docs). Common requests:

- Wire OpenRouter / OpenAI / a custom endpoint with the user's own key — verify
  the key works before going further.
- "Use my workspace Gemini / no API cost" and similar — set the matching
  provider/model in config; confirm the model ID is current and supported.
- If a Portal login code is rejected, re-run `hermes setup --portal` and check
  the user is pasting the current code.

## Key features to configure

- **Personality (`SOUL.md`)** — defines the agent's default voice/tone. Users
  often ask to generate or update it. Keep it a plain Markdown persona file.
- **Memory** — persistent, grows across sessions; mostly automatic.
- **Skills** — procedural memory the agent creates and reuses; compatible with
  the open agentskills.io standard, so skills are portable.
- **MCP integration** — Hermes can connect to MCP servers and filter their
  tools. For config-file mechanics, see `claude-desktop-mcp.md`; for Hermes-side
  specifics see the docs' MCP page.
- **Messaging gateway** — Telegram, Discord, Slack, WhatsApp, Signal, Teams, and
  20+ platforms from one gateway. Telegram is the quickest to validate.
- **Backends** — Hermes can run on 6 terminal backends: local, Docker, SSH,
  Daytona, Singularity, Modal. Daytona/Modal give serverless persistence (idle
  ≈ free). Pick local for a first run; Docker if the user wants isolation.

## Troubleshooting checklist

1. **Install/update stuck** → check the installer/log output; confirm the
   runtime and PATH; on Windows watch for permission/antivirus interference.
   Re-run the installer if needed.
2. **"Agent won't respond / got stuck"** → run the generic diagnostic: provider
   key valid + has credit → model exists and supports tools → process running →
   read logs for the first real error.
3. **Portal/auth errors** → re-run `hermes setup --portal`; verify the account
   and code.
4. **Provider model errors (404/402/403)** → switch to a current, available
   model.

See the FAQ & Troubleshooting page in the docs for tool- and platform-specific
fixes.
