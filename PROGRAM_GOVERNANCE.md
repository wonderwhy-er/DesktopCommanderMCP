# Program Governance: Safe Executor Stabilization

## Scope
This repository is the source of truth for Safe Executor stabilization work.

## Required Thread Artifacts
Every implementation thread must include:
- `THREAD_STANDARD.md` as the operating baseline.
- `THREAD_REVIEW.md` updated at closeout with validation and residual risks.

## Tracking Labels
Use these labels for issues and milestones:
- `executor-hardening`
- `eval-gate`
- `security-p0`
- `rollout-optin`

## Closeout Requirements
A thread is considered complete only when:
- acceptance criteria are mapped to code + tests,
- security defaults are preserved when feature flags are off,
- residual risks and next gate are documented in `THREAD_REVIEW.md`.

## Internal Rollout Operations (Q1 2026)
During internal Safe Executor rollout, teams must also follow:
- `/Users/test1/DesktopCommanderMCP/operations/rollout/README.md`
- `/Users/test1/DesktopCommanderMCP/operations/rollout/INTEGRATION_PR_CHECKLIST.md`
- `/Users/test1/DesktopCommanderMCP/operations/rollout/PILOT_WORKFLOWS.md`
- `/Users/test1/DesktopCommanderMCP/operations/rollout/WEEKLY_OPERATIONS_CHECKLIST.md`
