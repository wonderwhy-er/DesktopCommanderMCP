## Title
Safe Executor v1 + MCP utilization standard (internal rollout)

## Summary
- Packages Safe Executor runtime, skill resources/views, and governance/rollout standards into a single integration set.
- Keeps single control plane architecture in `/Users/test1/DesktopCommanderMCP`.
- Uses strict safety defaults and reason-coded guardrails.

## Included
- Skills tools and guarded execution flow (`run_skill`, `approve_skill_run`, `get_skill_run`, `cancel_skill_run`).
- Read-only resources (`dc://skills/catalog`, `dc://skills/eval-gate`, `dc://skills/runs/{runId}`).
- Governance and rollout docs under `operations/rollout/`.
- Pilot evidence and baseline snapshots under `operations/rollout/2026-02-23/`.

## Validation
- Full test run result: see `operations/rollout/2026-02-23/npm_test.log` and summary file.
- Pilot run evidence: `operations/rollout/2026-02-23/pilot_run_summary.md`.
- Eval gate snapshot: `operations/rollout/2026-02-23/skills_eval_gate_snapshot.json`.

## Security Defaults Confirmed
- `commandValidationMode = strict`
- `skillExecutionMode = confirm`
- `toolCallLoggingMode = redacted`
- `skillExecuteEvalGateEnabled = true` (enforced post-sampling)

## Known Environment-specific Notes
- PDF creation test may hit `listen EPERM` in restricted sandbox; test includes environment-safe skip path.

## Rollout Scope
- Internal opt-in only for this phase.
