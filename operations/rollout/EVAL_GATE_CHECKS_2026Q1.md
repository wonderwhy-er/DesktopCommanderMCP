# Eval Gate Checks (Q1 2026)

Use this file to record the 3 consecutive gate checks required before broader internal rollout.

## Gate policy
- Source of truth: `dc://skills/eval-gate`
- Required:
  - `stats.totalRuns >= 50`
  - `stats.passRate >= 0.95`
  - 3 consecutive checks meeting threshold

## Check #1 (2026-02-23)
- Evidence file: `operations/rollout/2026-02-23/skills_eval_gate_snapshot.json`
- Result:
  - `totalRuns = 3`
  - `passRate = 1.0`
  - `allowed = false`
  - `reasonCode = eval_gate_blocked`
- Decision: **NO-GO** (insufficient sample size)

## Check #2 (pending)
- Date:
- Evidence file:
- Result:
- Decision:

## Check #3 (pending)
- Date:
- Evidence file:
- Result:
- Decision:

## Final internal rollout decision gate
- Go only if Check #1-#3 are all passing.
