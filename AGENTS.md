# DesktopCommanderMCP Repo Instructions

## Scope
These instructions apply to work in `/Users/test1/DesktopCommanderMCP`.

## Operating Standard
- Follow `/Users/test1/DesktopCommanderMCP/THREAD_STANDARD.md` for all implementation threads.
- Keep `/Users/test1/DesktopCommanderMCP/THREAD_REVIEW.md` updated at closeout.
- Treat `/Users/test1/DesktopCommanderMCP/PROGRAM_GOVERNANCE.md` as the program checklist.
- For internal Safe Executor rollout work, also follow `/Users/test1/DesktopCommanderMCP/operations/rollout/README.md`.

## Safety Bar (Non-Negotiable)
- Preserve secure-by-default behavior when feature flags are off.
- Keep tool schemas strict for risky tools and skill tooling.
- Require explicit approvals for execution paths (`run_skill(mode=execute)` via confirm flow).
- Keep command validation fail-closed in strict mode.
- Do not log raw sensitive payloads; default to redacted/metadata logging.

## Skills Layer
- Skills must be scoped, allowlisted, and reason-coded on failure.
- Prefer deterministic scripts for repeatable operations.
- New read-only “status views” should use MCP resources; mutations must remain tools.

## Source Policy
- OpenAI product decisions should be grounded in official OpenAI docs.
- MCP protocol/security decisions should be grounded in `modelcontextprotocol.io` documentation.
