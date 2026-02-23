# MCP Utilization Standard v1 (2026-02-14)

## Purpose
Define a deterministic, security-first way to use MCP servers in this program so thread outcomes are repeatable and auditable.

## 1. Control-Plane Decision
- Use a single control plane: `/Users/test1/DesktopCommanderMCP`.
- Do not create a new MCP codebase by default.
- Revisit server split only after sustained divergence (>1 release cycle) or hard trust/runtime boundaries.

## 2. Routing Matrix
- `desktop-commander`: local execution, file/process/search tools, skill lifecycle tools, eval-gate operations.
- `figma`: design context extraction and implementation fidelity inputs.
- `playwright`: browser validation, UI interaction checks, capture/debug flows.
- `notion`: planning knowledge capture, meeting/research documentation.
- `linear`: issue tracking and implementation workflow status.
- `openaiDeveloperDocs`: official OpenAI API/Codex/Agents documentation lookup.

## 3. Resource-vs-Tool Policy
- Use MCP resources for read-only context state.
- Use tools for mutation/execution.
- Skill execution remains tool-driven (`run_skill`, `approve_skill_run`, `cancel_skill_run`).

## 4. Source Policy (Required)
- Use official documentation first for architecture/security decisions.
- OpenAI decisions: prefer `developers.openai.com` and `platform.openai.com`.
- MCP decisions: prefer `modelcontextprotocol.io`.
- If fallback browsing is required, restrict to official domains and cite concrete URLs.

## 5. OpenAI Docs MCP Verification
Run these checks when enabling or modifying OpenAI docs integration:
1. Connectivity check:
- confirm `openaiDeveloperDocs` exists in `/Users/test1/.codex/config.toml`.
2. Sanity query:
- run one documentation search and confirm at least one result is returned.
3. Fallback policy:
- if MCP docs server is unavailable, log fallback reason in-thread and still cite official OpenAI URLs.

## 6. Thread Preflight (Required)
Before implementation, capture:
- date stamp (absolute date),
- objective and non-goals,
- risk class (`low|medium|high`),
- runtime controls: `approval_policy`, `sandbox_mode`, `network_access`,
- active MCP servers in scope for that thread.

## 7. Rollout Policy
- R1: standards and docs-server integration only.
- R2: enable read-only resources in opt-in environments.
- R3: apply operations skill in active threads.
- R4+: evaluate split only if split criteria persist.
