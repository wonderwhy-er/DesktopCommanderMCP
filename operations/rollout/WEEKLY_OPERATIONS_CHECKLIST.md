# Weekly Operations Checklist

Use this every week during internal rollout.

## 1) Governance review
- [ ] Active threads use required preflight fields.
- [ ] Thread closeouts update `THREAD_REVIEW.md`.
- [ ] Routing follows `MCP_UTILIZATION_STANDARD.md`.

## 2) Security review
- [ ] Blocked commands still blocked.
- [ ] `commandValidationMode = "strict"` remains enforced for execute mode.
- [ ] Tool-call logs remain `metadata`/`redacted` (no raw sensitive payloads).
- [ ] Telemetry config remains environment-driven (no hardcoded secrets).

## 3) Skills/eval review
- [ ] `dc://skills/catalog` loads and parse errors are tracked.
- [ ] `dc://skills/eval-gate` snapshot recorded.
- [ ] Execute pass-rate and sample-size trend reviewed.
- [ ] Top reason codes reviewed and assigned remediation actions.

## 4) Regression review
- [ ] Non-skill tools behavior unchanged when `skillsEnabled = false`.
- [ ] Confirm flow still transitions correctly.
- [ ] Cancel flow still terminates runs as expected.

## 5) Decision log
- [ ] Go/no-go decision for broader internal usage recorded.
- [ ] Residual risks and mitigations recorded.
