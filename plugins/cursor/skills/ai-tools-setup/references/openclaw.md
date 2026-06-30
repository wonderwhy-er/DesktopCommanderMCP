# OpenClaw

OpenClaw is a self-hosted, multi-channel **gateway for AI agents** — one Gateway
process bridges chat apps (Discord, iMessage, Signal, Slack, Telegram, WhatsApp,
and more) to an AI agent. MIT licensed. Official docs: https://docs.openclaw.ai/
(append `/index.md` or use the "View as Markdown" links for clean text).

Always confirm current commands against the docs — OpenClaw releases often.

## Install & first run

Requirements: Node 24 recommended (Node 22.19+ works), plus an API key from a
model provider.

```bash
# Install
npm install -g openclaw@latest

# Guided onboarding + install the background service
openclaw onboard --install-daemon

# Open the browser Control UI
openclaw dashboard
```

The Control UI default is `http://127.0.0.1:18789/`. (Some versions/setups use a
nearby port — if 18789 doesn't load, check the onboarding output or
`openclaw doctor` for the actual port.)

Fastest way to chat from a phone: connect the **Telegram** channel.

## Config

- Main config lives at `~/.openclaw/openclaw.json`.
- With no config, OpenClaw uses its bundled agent runtime with per-sender
  sessions.
- Lock-down basics: channel allowlists (e.g. `channels.whatsapp.allowFrom`) and
  group mention rules.

Run the built-in diagnostics whenever something is off:

```bash
openclaw doctor
```

If it reports "Config invalid," fix the JSON (back it up first) and re-run.

## Providers & models (the most common pain)

OpenClaw needs a model provider configured. Recurring issues and fixes:

- **"No API key found for provider X"** — auth is configured per agent. Add the
  provider's credentials for the active agent (via onboarding/`openclaw agents`),
  or copy the auth profile from the main agent. Confirm the key is valid and has
  credit *before* further setup.
- **Model doesn't support tools** — some local models (e.g. certain distilled
  reasoning models) can't do tool-calling, which the agent needs. Switch to a
  model that supports tools.
- **Local models** — running via Ollama or LM Studio is common for cost reasons.
  Watch for: the local server not running, the wrong base URL/port, GPU not
  engaged / high RAM, and prompt-template mismatches (LM Studio "jinja" errors —
  switch the model's preset/template). See the docs' Models/Providers section.
- **Provider churn** — model names get deprecated and accounts get rate-limited
  or model-blocked. When you hit a 402/403/404 from a provider, switch to a
  current, available model rather than retrying.

For best quality and security the docs recommend the strongest current-gen model
available.

## Channels

Each chat platform is a "channel" with its own setup (token/pairing). Telegram
is the quickest to validate. Configure one channel, confirm a round-trip
message, then add others. See https://docs.openclaw.ai/channels.

## Remote access

To reach the gateway from outside the machine, use the documented patterns
(SSH / tailnet). Tailscale is covered at
https://docs.openclaw.ai/gateway/tailscale. Avoid exposing the dashboard
directly to the public internet.

## Troubleshooting checklist

1. `openclaw doctor` — start here.
2. **Gateway `Unauthorized`** at the dashboard URL → the gateway token/auth
   isn't set or the URL/port is wrong; re-check onboarding output and config.
3. **Connects but `disconnected (1006): no reason`** on first message → almost
   always a provider/model problem (missing key, unsupported model), not the
   network. Run the provider/model checks above.
4. **Module/runtime errors** → confirm Node version; reinstall if needed.
5. Read logs with `openclaw logs --follow`.

## Uninstall / cleanup

- Stop the service/daemon, then `npm uninstall -g openclaw`.
- Remove residual files in `~/.openclaw/` (back up first if it holds config the
  user may want).
- Disable any autostart entry created during onboarding.
