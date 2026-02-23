# Internal Rollout Plan (Q1 2026)

This folder operationalizes the Safe Executor utilization plan for internal rollout.

## Scope
- Single control plane repo: `/Users/test1/DesktopCommanderMCP`
- Internal opt-in rollout window: **February 23, 2026 to March 20, 2026**
- Safety defaults remain enabled:
  - `commandValidationMode = "strict"`
  - `skillExecutionMode = "confirm"`
  - `toolCallLoggingMode = "redacted"`
  - `skillExecuteEvalGateEnabled = true`

## What lives here
- `INTEGRATION_PR_CHECKLIST.md`: required checklist and PR body template.
- `PILOT_WORKFLOWS.md`: three pilot workflows with inputs/artifacts/pass-fail/rollback.
- `WEEKLY_OPERATIONS_CHECKLIST.md`: weekly governance/security/docs cadence.
- `THREAD_PREVIEW_TEMPLATE.md`: copy/paste preflight + closeout template for each thread.
- `2026-02-23/`: baseline snapshots and dated evidence.

## Go / No-Go rule
Execute-mode internal rollout expands only if:
1. `dc://skills/eval-gate` reaches sample and pass-rate thresholds.
2. No P0 security regressions appear during pilot runs.
