# Thread Standard v1 (2026-02-14)

## Purpose
Use this standard for implementation threads so work is reproducible, auditable, and safe by default.
This standard is operationalized in `/Users/test1/DesktopCommanderMCP/PROGRAM_GOVERNANCE.md`.

## 1. Thread Intake (required)
Capture these before implementation starts:
- Date stamp (absolute date).
- Primary objective and non-goals.
- Explicit acceptance criteria.
- Risk class: `low | medium | high`.
- Security posture required (`approval_policy`, `sandbox_mode`, network expectations).
- Runtime controls: `approval_policy`, `sandbox_mode`, `network_access`.
- Active MCP servers in scope for the thread.
- Time references using absolute dates.

## 2. Instruction Layering (required)
Follow Codex instruction precedence and keep instructions local to scope:
- Global instructions in `~/.codex/AGENTS.md`.
- Repo instructions in `AGENTS.md` at repo root.
- Narrow overrides via `AGENTS.override.md` only for subtrees that need different rules.
- Verify active instruction chain when needed.

## 3. Security Baseline (required)
Default baseline for development and agentic execution:
- Prefer `sandbox_mode = "workspace-write"` with approvals.
- Prefer `approval_policy = "untrusted"` or `"on-request"`.
- Keep `network_access = false` unless a reviewed need exists.
- Do not use `danger-full-access` except in isolated, controlled environments.
- Require explicit approval before mutating operations in risky contexts.

## 4. Architecture Selection (required)
Choose the minimum orchestration needed:
- Start with one agent and clear tool boundaries.
- Add multi-agent routing only when tasks are clearly separable or instruction/tool complexity is too high.
- Keep human-in-the-loop checkpoints for consequential actions.

## 5. Tool and Skill Contract Standard (required)
For new tools/skills:
- Keep tool schemas strict (`additionalProperties: false`, strict validation).
- Enforce allowlists and scoped paths for execution primitives.
- Hide feature-flagged tools when disabled.
- Prefer deterministic scripts for repeated operations.
- Return structured, actionable errors with reason codes.

## 6. Execution Lifecycle (required)
Use explicit run states for agentic operations:
- `queued -> planning -> waiting_approval -> executing -> verifying -> completed|failed|canceled`.
- `plan` mode must be deterministic and side-effect free.
- `execute` mode must enforce approval and safety guards.
- `verify` must run before `completed` can be set.

## 7. Evals and Rollout Gates (required)
Adopt eval-driven delivery:
- Add scoped unit/integration/security tests with each phase.
- Add golden scenarios for core workflows.
- Add adversarial and bypass tests for guardrails.
- Gate rollout by measured pass thresholds, not intuition.

## 8. Observability and Privacy (required)
- Telemetry/logging must be opt-in and environment-driven.
- Never store raw secrets or sensitive payloads in logs.
- Prefer metadata/redacted logging modes by default.
- Emit structured events for run lifecycle and safety blocks.

## 8.1 Source Policy (required)
- Prefer official docs for architecture and security decisions.
- OpenAI product guidance: cite `developers.openai.com` / `platform.openai.com`.
- MCP protocol guidance: cite `modelcontextprotocol.io`.
- If fallback browsing is required, restrict to official domains and cite concrete URLs.

## 9. Definition of Done (required)
A thread is done only when all are true:
- Acceptance criteria are mapped to code/tests.
- Build passes and relevant tests pass.
- Security defaults preserved when feature flags are off.
- Thread review document is updated with outcomes and residual risks.

## 10. Thread Closeout Template
Use this at thread end:
- Primary task.
- Options considered and selected path.
- What changed (files/tools/config).
- Validation run (build/tests/evals).
- What remains (if anything) with explicit next gate.

## 11. Operational Template (Q1 2026 rollout)
For internal Safe Executor rollout threads, use:
- `/Users/test1/DesktopCommanderMCP/operations/rollout/THREAD_PREVIEW_TEMPLATE.md`
