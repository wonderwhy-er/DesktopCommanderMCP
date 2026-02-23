# Rollout Thread Notes (2026-02-23)

## Baseline freeze
- Branch: `codex/mcp-utilization-skills-standard`
- Control plane repo: `/Users/test1/DesktopCommanderMCP`

## Saved artifacts
- `status_snapshot.json`
- `eval_gate_report.json`
- `rollout_checklist.json`

## Runtime baseline at snapshot time
- `skillsEnabled = true`
- `commandValidationMode = strict`
- `skillExecutionMode = confirm`
- `toolCallLoggingMode = redacted`
- `skillExecuteEvalGateEnabled = true`
- `skillExecuteMinPassRate = 0.95`
- `skillExecuteMinSampleSize = 50`

## Notes
- This snapshot is local configuration evidence.
- Live run/eval decisions should also be checked using `dc://skills/eval-gate`.

## Pilot execution results
- Pilot report: `pilot_run_report.json`
- Pilot summary: `pilot_run_summary.md`
- Outcome: all 3 pilot workflows reached `waiting_approval` and completed after approval.
- Temporary sampling override used:
  - `skillExecuteEvalGateEnabled` set to `false` during pilot execution.
  - Setting restored to `true` immediately after pilots.

## Eval gate status after pilots
- Snapshot: `skills_eval_gate_snapshot.json`
- Current status: `allowed=false` (`eval_gate_blocked`)
- Reason: sample size below threshold (`3/50`)
