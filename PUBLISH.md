# Release Guide for Desktop Commander MCP

Releases are published by CI (`.github/workflows/release.yml`). A release goes to
**four places from one trigger**:

1. **npm** — `@wonderwhy-er/desktop-commander`
2. **GitHub release** — with the `desktop-commander-<version>.mcpb` asset attached
3. **Claude directory** — GitHub releases expose the MCPB asset for Anthropic's
   directory pipeline; actual ingestion depends on Anthropic and must be verified
4. **MCP Registry** — `io.github.wonderwhy-er/desktop-commander`

**Who can release:** anyone with write (push) access to this repository. Both the
tag push and the Actions "Run workflow" button require write permission. No npm
login, no mcp-publisher, no personal auth, no secrets anywhere — CI publishes
to npm via OIDC trusted publishing and to the MCP Registry via GitHub OIDC.

---

## Normal release (terminal)

```bash
npm run release          # patch  (0.2.47 → 0.2.48)
npm run release:minor    # minor  (0.2.47 → 0.3.0)
npm run release:major    # major  (0.2.47 → 1.0.0)
npm run release:dry      # preview the plan, change nothing
```

The script shows the full plan and asks for one confirmation:

```
Release plan:
  1. Run tests (local, nothing changed yet)
  2. Bump version 0.2.47 → 0.2.48 and commit
  3. Push main + tag v0.2.48 to origin — this starts the CI release:
     build MCPB → publish npm → GitHub release with .mcpb asset
     (picked up by the Claude directory) → publish MCP Registry

Release v0.2.48 now? [y/N]
```

After you confirm: tests run locally, the version is bumped and committed, and
the tag push hands off to CI. Watch the run at
https://github.com/wonderwhy-er/DesktopCommanderMCP/actions/workflows/release.yml

Requirements: on `main`, clean working tree, tests passing. `--yes` skips the
prompt. `npm run release -- --skip-tests` dispatches CI with the test-suite
skip checkbox set; CI still builds and verifies the MCPB before publishing.

## Normal release (GitHub UI — no local setup at all)

1. Actions → **Release** → **Run workflow** (from `main`)
2. Pick `bump` = patch / minor / major
3. Optionally select **Skip tests** if the candidate has already passed testing
4. Run

By default CI runs the full tests, bumps the version, commits and tags `main`,
then publishes everywhere. **Skip tests** bypasses only the full test suite;
dependency installation, MCPB build, version consistency and bundle validation
remain mandatory. Skipped tests are recorded as a warning in the workflow log.

When the current version is an alpha such as `0.3.2-alpha.3`, **patch**
promotes it directly to `0.3.2`, not `0.3.3`. Minor and major still
advance to `0.4.0` and `1.0.0` respectively.

---

## Partial releases (skip some targets)

Sometimes you only want a subset (npm outage, registry problem, npm-only fix).
Both entry points support it:

**Terminal** (dispatches to CI via `gh`, needs `gh auth login` once):

```bash
npm run release -- --skip-registry                    # npm + GitHub release only
npm run release -- --skip-npm --skip-registry         # GitHub release/MCPB only
npm run release -- --skip-github-release --skip-registry   # npm only
```

**GitHub UI**: same Run workflow dialog — check `skip_npm`, `skip_registry`,
and/or `skip_github_release`.

**Completing a partial release later** (e.g. released npm-only, now want the
rest): re-release the existing tag — every publish step detects targets that
already have the version and skips them, so only the missing ones run:

```bash
npm run release -- --tag=v0.2.48        # completes whatever v0.2.48 is missing
```

(or UI: Run workflow with `tag` = `v0.2.48`, nothing else)

One ordering rule: the MCP Registry validates that the npm package exists, so
you cannot publish a **new** version to the registry while skipping npm.
Publish npm first, complete the registry later with `--tag=`.

## Rehearsal — test the pipeline without releasing

```bash
npm run release:rehearsal
```

Force-pushes a `test-v<version>` tag at your current HEAD (any branch). CI runs
the **entire pipeline in safety mode**: MCPB is built for real, `npm publish
--dry-run` (tarball contents in the log, nothing uploaded), the GitHub release
is created as a **draft** with the `.mcpb` attached (invisible without repo
write access), and the registry step validates `server.json` and proves the
OIDC login without publishing.

Use it to validate workflow changes before they reach main — tag-triggered
runs execute the workflow file at the tagged commit, so your branch's copy is
what runs. Repeatable: re-running force-moves the same tag.

Afterwards: check the run summary, optionally download the `.mcpb` from the
draft and install it in Claude Desktop, then clean up:

```bash
gh release delete test-vX.Y.Z --yes
git push origin :refs/tags/test-vX.Y.Z && git tag -d test-vX.Y.Z
```

## When a release fails mid-way

Click **"Re-run failed jobs"** on the failed Actions run. Publish steps are
idempotent (already-published targets are skipped), so the re-run finishes only
what's missing. If the failure needed a workflow fix, land the fix on `main`
first and use `--tag=vX.Y.Z` / the UI `tag` field instead — dispatch runs
`main`'s copy of the workflow.

## Alpha releases

```bash
npm run release:alpha    # 0.2.47 → 0.2.48-alpha.0 → npm only, under the alpha dist-tag
```

Alphas are the one flow that still publishes from your machine (needs
`npm login`). No git tag, no CI, no GitHub release, no registry — CI
intentionally refuses publishing pre-release tags. After alpha testing,
choose `bump=patch` in the GitHub Actions release workflow to promote
`0.3.2-alpha.N` directly to stable `0.3.2`.

Install an alpha with: `npm install -g @wonderwhy-er/desktop-commander@alpha`

## Repository-root MCPB manifest (discovery experiment)

The repository includes [`manifest.json`](manifest.json) at its root to make
**the most recently published stable MCPB metadata** discoverable without downloading
an archive. This mirrors the layout used by some other MCPB projects but is an
**experiment**, not a documented Claude directory-update trigger.

- `manifest.template.json` remains the source of truth for MCPB metadata.
- `npm run sync-version` (and `npm run bump`) regenerates the root manifest
  when `package.json` contains a stable `X.Y.Z` version. The release scripts
  include the regenerated file in the release commit.
- While the working tree is on an alpha/beta version, the root manifest deliberately
  stays at the last stable release. Never advertise prerelease metadata to
  an unknown external directory crawler.
- The root copy omits `$schema` because its relative path is valid only for
  the bundle build directory. The actual `.mcpb` is still assembled from the
  template by `scripts/build-mcpb.cjs`.
- Release CI checks that the root manifest and the bundled manifest match
  (ignoring the bundle-only `$schema`) before publishing.

**Important:** The [official MCPB spec](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
requires `manifest.json` *inside the bundle*, not at the GitHub root.
There is no verified documentation that a root manifest or an npm update causes
Anthropic to refresh a directory listing. Directory publishing and the existing
Anthropic escalation remain separate operational steps.

---

## Release notes

CI creates the GitHub release with GitHub's auto-generated notes (the list of
merged PRs since the previous tag). Edit the release afterwards to curate them —
editing notes after publishing is safe and doesn't affect npm, the registry, or
the Claude directory (the scanner reads the `.mcpb` asset, not the notes).

---

## One-time setup (repository admin)

| What | Where | Why |
|---|---|---|
| npm trusted publisher | npmjs.com → `@wonderwhy-er/desktop-commander` → Settings → Trusted Publisher | GitHub Actions: user `wonderwhy-er`, repo `DesktopCommanderMCP`, workflow `release.yml`, environment empty. No token, no secret — CI publishes via OIDC with automatic provenance. Configured by any package owner. |
| MCP Registry auth | nothing to set up | CI uses `mcp-publisher login github-oidc`; the registry grants `io.github.wonderwhy-er/*` to workflows running in this repo automatically. |
| Claude directory channel | email to our Anthropic contact | one-time registration: repo `wonderwhy-er/DesktopCommanderMCP`, tag pattern `v*`, asset pattern `desktop-commander-*.mcpb`, maintainer contact. After this, every release is ingested automatically. |

## What runs where (reference)

| Step | Normal (terminal) | UI / dispatch |
|---|---|---|
| Tests | locally, before anything changes | in CI, before the bump |
| Version bump + commit + tag | locally by the script | in CI by the workflow |
| MCPB build, npm, GitHub release, registry | CI | CI |

Version consistency is enforced twice: `scripts/sync-version.js` keeps
`package.json`, `server.json`, and `src/version.ts` in lock-step, and CI
refuses to publish if the tag and those files disagree.

## Registry information

- **npm package**: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
- **MCP Registry**: https://registry.modelcontextprotocol.io/ (`io.github.wonderwhy-er/desktop-commander`)
- **GitHub releases**: https://github.com/wonderwhy-er/DesktopCommanderMCP/releases
- Registry versions are **immutable**: a published version can never be
  overwritten, only superseded by a new version (or hidden with
  `mcp-publisher status --status deleted`).

## Troubleshooting

- **npm publish failed in CI**: check the trusted-publisher config on
  npmjs.com still matches (repo `DesktopCommanderMCP`, workflow
  `release.yml`, environment empty); re-run failed jobs.
- **Registry publish failed with 401/audience error**: the mcp-publisher binary
  or registry API changed; check the workflow's install step, re-run.
- **"Version mismatch" in CI**: the tag doesn't match `package.json`/
  `server.json` — the tag was cut by hand. Delete the tag, use the script.
- **Tag exists but no workflow ran**: the tagged commit predates
  `release.yml` on that ref, or the tag doesn't match `v*`. Use
  `npm run release -- --tag=vX.Y.Z` to release it via dispatch.
- **Same-version re-release**: npm and the registry both refuse duplicate
  versions — that's what makes re-runs safe. To ship a fix, bump again.
