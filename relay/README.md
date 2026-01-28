# Automation Relay

LMAOS Design System relay configuration for agent orchestration.

## Overview

This directory contains configuration and scripts for the LMAOS Design System automation relay, enabling multi-agent orchestration across:
- Claude Agent (orchestrator)
- Prime Agent (executor)
- RepoAgent L4 (repository manager)

## Files

| File | Purpose |
|------|---------|
| `config.json` | Relay configuration (endpoints, agents, repos) |
| `phase2-phase3-execution.sh` | M4 Pro setup script (Phase 2 AOE wiring + Phase 3 prep) |

## Quick Start

```bash
# On Mac Mini M4 Pro
chmod +x relay/phase2-phase3-execution.sh
./relay/phase2-phase3-execution.sh
```

## Endpoints

| Endpoint | URL |
|----------|-----|
| Base | `https://relay.activ8ai.app` |
| Claude | `https://relay.activ8ai.app/webhook/claude` |
| Prime | `https://relay.activ8ai.app/webhook/prime` |
| Notion | `https://relay.activ8ai.app/webhook/notion` |
| Health | `https://relay.activ8ai.app/health` |

## Charter Compliance

- Version: v1.3.1
- Principles: Evidence-first, zero-drift
- Audit: All operations logged with timestamps

## Related

- [MAOS Portal Architecture Hub](https://notion.so)
- Teamwork Project: LMAOS (510271)
