# Pilot Workflows (Internal Opt-In)

This file defines the three pilot workflows for rollout validation.

## Common settings (all pilots)
- `skillsEnabled = true`
- `commandValidationMode = "strict"`
- `skillExecutionMode = "confirm"`
- Record each run with:
  - `runId`
  - final state
  - `executionSummary.passed`
  - reason codes on failures

## Pilot A: Ops Rollout Diagnostics
- Skill: `desktop-commander-ops`
- Goal examples:
  - "validate eval gate readiness and rollout blockers"
  - "generate rollout checklist and diagnostics"
- Expected artifacts:
  - config/eval snapshots
  - rollout checklist summary
- Pass condition:
  - `run_skill(mode=execute)` reaches `waiting_approval`
  - `approve_skill_run` reaches `completed` with passed summary
- Rollback action:
  - set `skillExecutionMode = "plan_only"` if repeated failures occur

## Pilot B: Code Audit Workflow (Read/Search Heavy)
- Skill: `security-best-practices`
- Goal examples:
  - "audit codebase for security hardening gaps with safe read/search steps"
- Expected artifacts:
  - findings list (or explicit no-findings output)
  - referenced files/paths
- Pass condition:
  - plan mode deterministic output
  - execute path runs safe step types and verifies
- Rollback action:
  - keep plan mode only while fixing blocked reason codes

## Pilot C: Refactor Helper Workflow (Guarded Execute)
- Skill: `desktop-commander-ops` (refactor-assist goal)
- Goal examples:
  - "prepare safe refactor helper plan and verification checks"
- Expected artifacts:
  - stepwise plan
  - verification/rollback hints
- Pass condition:
  - confirm flow behaves correctly (`waiting_approval` -> `executing` -> terminal state)
  - reason codes are structured when blocked/failed
- Rollback action:
  - disable execute for this workflow and continue with plan mode only

## Run sequence template (all pilots)
1. `run_skill(mode="plan")`
2. `run_skill(mode="execute")`
3. if `waiting_approval`, call `approve_skill_run(runId)`
4. `get_skill_run(runId)` and capture final report

## Failure logging format
- `timestamp`
- `pilot`
- `runId`
- `state`
- `reason_code`
- `short_root_cause`
- `next_action`
