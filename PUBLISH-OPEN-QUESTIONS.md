# Release process — open questions

Decisions we deliberately postponed. Companion to `PUBLISH.md`.

## 1. Release notes: hands-off vs draft-gate

**Current behavior (hands-off):** CI publishes the GitHub release immediately
with GitHub's auto-generated notes (merged-PR list since the last tag). Notes
are curated by editing the release *after* publishing — safe, since npm, the
registry, and the Claude directory scanner never read the notes.

**Option: draft-gate.** CI creates the release as a **draft** with the `.mcpb`
attached and stops. A human polishes the notes and clicks Publish; a second
workflow on the `release: published` event then runs npm + registry publish.

- For: human control point mid-release; notes are always curated before anyone
  sees them; nothing public until a person approves.
- Against: pipeline splits into two workflows; a release can sit half-done in
  draft; npm/registry publication waits on a human click; more states to
  document and debug.

**Decision pending.** Revisit after a few releases with the hands-off flow.

## 2. Anthropic directory registration — when, and who is the contact

Registering the release channel with Anthropic (via our contact, Bryan) is a
one-time email: repo `wonderwhy-er/DesktopCommanderMCP`, tag pattern `v*`,
asset pattern `desktop-commander-*.mcpb`, plus a **maintainer contact** they
use for validation feedback and breaking-change questions.

Open:
- **When to send:** planned for after the first successful CI release (so a
  real asset exists and the pipeline is proven). Until it's sent, new versions
  don't flow to the Claude directory — the old email path is also gone, so
  don't delay it long after the pipeline works.
- **Who is the maintainer contact:** a person or a shared inbox? (Their
  validation issues arrive there or as GitHub issues on the repo.)
- Note: once registered, every `v*` tag with a matching asset is ingested
  automatically — including releases we might not want in the directory.
  If that ever matters, we'd need a separate tag pattern for directory-bound
  releases.

## 3. Smaller loose ends

- **`npm pkg fix`**: npm warns on publish that it auto-corrects some
  `package.json` format issues. Cosmetic; run `npm pkg fix` and commit sometime.
- **Registry verify loop**: the final "verify registry publish" step re-checks
  our own publish — arguably redundant (the npm one is load-bearing, the
  registry one is belt-and-braces). Drop it if it ever annoys.
- **PR #626** (registry PAT via GCP Secret Manager): obsolete under this
  pipeline — the local script no longer publishes to the registry at all and
  CI uses OIDC. Close it with a note to Eduards when this branch merges.
- **sharp / PDF image extraction in the MCPB**: decided 2026-08-26 — NOT
  bundling cross-platform sharp binaries (would roughly double the ~52 MB
  bundle). CI-built MCPBs carry linux-x64 sharp only, so image extraction
  when reading PDFs stays silently inactive on macOS/Windows MCPB installs
  (it was Apple-Silicon-only before, so no regression for most users, but it
  is now inert for everyone on Desktop). Revisit if the feature matters.
