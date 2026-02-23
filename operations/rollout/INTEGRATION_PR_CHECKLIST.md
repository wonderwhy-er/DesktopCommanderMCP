# Integration PR Checklist

## PR title
`Safe Executor v1 + MCP utilization standard (internal rollout)`

## Required checklist (must all be checked)
- [ ] Branch is `codex/mcp-utilization-skills-standard`
- [ ] Full test run recorded (`npm test`)
- [ ] Security defaults confirmed:
  - [ ] `skillsEnabled` setting handled correctly in tools visibility
  - [ ] `commandValidationMode = strict` enforced for execute paths
  - [ ] tool-call logging mode defaults to redacted/metadata behavior
- [ ] Resource/tool parity confirmed:
  - [ ] `dc://skills/catalog`
  - [ ] `dc://skills/eval-gate`
  - [ ] `dc://skills/runs/{runId}`
  - [ ] skill tools wired and stable (`run_skill`, `approve_skill_run`, etc.)
- [ ] Known environment-specific behavior documented:
  - [ ] sandbox PDF creation test can require a skip path for `listen EPERM`
- [ ] Pilot workflow docs included (`operations/rollout/PILOT_WORKFLOWS.md`)
- [ ] Weekly operational checklist included (`operations/rollout/WEEKLY_OPERATIONS_CHECKLIST.md`)

## PR body template
```md
## Summary
- Implements internal rollout utilization package for Safe Executor v1.
- Keeps single control plane architecture and strict safety defaults.

## Included
- Runtime/security/skills resources and tooling
- Governance and operational docs
- Pilot workflow definitions and rollout checklists

## Validation
- `npm test` result: <paste output summary>
- Key guardrail checks:
  - <check 1>
  - <check 2>

## Known environment notes
- PDF creation test may hit `listen EPERM` in restricted sandbox; handled as environment-specific.

## Rollout impact
- Internal opt-in only
- Execute mode remains gated and reason-coded
```
