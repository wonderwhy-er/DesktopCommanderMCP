---
name: obsidian-vault
version: 0.1.0
audience: agent
description: >-
  Organize Obsidian vaults with MOCs, wikilinks, frontmatter/properties,
  dashboards, orphan-note checks, and cleanup workflows. Use ONLY when the user
  explicitly refers to Obsidian — by naming "Obsidian", an Obsidian "vault", or
  an Obsidian-specific feature such as wikilinks ("[[ ]]"), the Dataview or Bases
  plugins, or Obsidian Properties. Within that Obsidian context it covers
  creating Maps of Content, adding/fixing wikilinks, finding orphan notes,
  normalizing YAML frontmatter, generating Dataview/Bases dashboards, organizing
  folders, deduplicating or renaming notes, and preparing the vault for AI use.
  Do NOT use this skill for generic note-taking, Markdown, or knowledge-base
  requests that don't mention Obsidian.
---

# Obsidian Vault Assistant

Help the user organize and maintain an Obsidian vault: build navigation with
MOCs and wikilinks, normalize metadata, generate dashboards, find and fix
orphans, organize folders, deduplicate/rename, and prepare the vault for AI use.

Obsidian-specific facts that shape every rule here:
- Links are **wikilinks** resolved by **filename**, not path: `[[Note title]]`.
  Renaming a note auto-updates links inside Obsidian, but moving files outside
  Obsidian breaks them — always rename via Obsidian when possible.
- Metadata is **Properties** (YAML frontmatter) at the top of a note.
- Dashboards come from **Dataview** (query language, read-only, flexible) or
  **Bases** (native, editable tables, fast on big vaults, properties-only).

Before acting, confirm the vault's root folder and whether the user has the
Dataview plugin installed (Bases is built in since Obsidian 1.9). When a request
is ambiguous (organize vs. clean up vs. dashboard), ask which task.

## Wikilinks

- Basic: `[[Three laws of motion]]` — resolves by filename, no extension/path.
- Display text (pipe): `[[atomic-habits|James Clear — Atomic Habits]]`.
- Heading link: `[[Note#Section]]`. Block link: `[[Note#^block-id]]`.
- Embed/transclude: `![[Note]]`, `![[Note#Section]]`, `![[image.png]]`.
- Aliases: add an `aliases` property so the note resolves under other names.
- Avoid `# | ^ : %` and `[ ]` in filenames — they have special meaning in links.
- Prefer wikilinks for internal navigation; use standard Markdown links only if
  the vault is also published to a tool that can't parse wikilinks.

When adding links, also surface **unlinked mentions**: if a note's title appears
as plain text in other notes, convert those to wikilinks.

## Maps of Content (MOCs)

A MOC is a note that links the related notes on a topic — the vault's navigation
layer (more flexible than folders or tags, and needs no institutional knowledge).

Conventions:
- Name MOCs clearly and tag them: `tags: [moc]` (or a `type: moc` property) so
  every MOC is itself discoverable.
- Keep a top-level **Home / Index MOC** that links to all topic MOCs.
- A MOC holds a short intro plus grouped wikilinks; it can be hand-curated or
  auto-generated with a Dataview/Bases query (see Dashboards).

MOC template:
```markdown
---
type: moc
tags: [moc]
updated: 2026-06-18
---
# Auth — Map of Content

Notes on authentication, sessions, and access control.

## Core
- [[auth-flow]]
- [[session-tokens]]

## Related MOCs
- [[security-moc]]
```

## Frontmatter / Properties

Add a consistent property block to every note. Recommended baseline:
```yaml
---
title: Session tokens
aliases: [tokens, session token]
tags: [auth, security]
type: note            # note | moc | dashboard | template | person | project
created: 2026-06-18
updated: 2026-06-18
status: evergreen     # seedling | growing | evergreen
related: ["[[auth-flow]]"]
---
```
Rules:
- Use a **controlled tag vocabulary** — decide tags up front and reuse them;
  nested tags (`auth/tokens`) are fine. Don't let tags sprawl.
- `tags` use no `#` in frontmatter. Dates in ISO `YYYY-MM-DD`.
- Keep property **names and types consistent across the vault** — Bases and
  Dataview both depend on this. When normalizing, pick one name per concept
  (e.g. `created`, not `created`/`date`/`Created`) and migrate the rest.

## Dashboards

Pick the engine based on the user's setup:

**Bases** (native, editable, fast — best for operational boards):
- Create a `.base` file or a `base` code block; it builds table/board views from
  properties. Each cell edits the underlying note's frontmatter.
- Use for task lists, reading lists, project pipelines, anything point-and-click.

**Dataview** (plugin, read-only, most flexible — best for reports/auto-MOCs):
```dataview
TABLE status, updated, tags
FROM #auth
WHERE type = "note"
SORT updated DESC
```
Auto-MOC of everything in a topic:
```dataview
LIST FROM #auth WHERE type != "moc" SORT file.name ASC
```
Recently updated:
```dataview
TABLE updated FROM "" WHERE updated >= date(today) - dur(7 days) SORT updated DESC
```
Note: large vaults can lag with heavy Dataview queries — prefer Bases there.

## Orphan notes & link hygiene

An orphan is a note with no inbound or outbound links. To find and fix:
1. **From Desktop Commander** (no app needed, scales to big vaults): `start_search`
   the vault for `[[ ]]` links to each note's title — zero hits means no inbound
   links (an *unlinked* note); to confirm a true orphan (no inbound **and** no
   outbound), also scan the note's own body for `[[...]]`. The same searches
   surface **unlinked mentions** (the title as plain text, not wrapped in `[[ ]]`)
   and **broken links** (a `[[target]]` whose file is missing).
2. **Graph view** (Cmd/Ctrl+G): orphans float as isolated dots at the edges.
3. **Dataview** query for notes with no links:
   ```dataview
   LIST WHERE length(file.inlinks) = 0 AND length(file.outlinks) = 0
   ```
4. For each orphan: link it from a relevant MOC/note (`edit_block` to insert the
   wikilink), tag it `#needs-link` for a batch pass, or archive if obsolete.
5. Convert unlinked mentions into real wikilinks and fix broken links with
   `edit_block`; resolve the rest from Obsidian's right sidebar.

## Folder organization

- Folders are for coarse buckets; **MOCs + tags do the real organizing**. Don't
  over-nest folders.
- A workable layout:
  ```
  00-inbox/        # unsorted captures
  10-notes/        # atomic notes
  20-mocs/         # maps of content
  30-projects/
  90-assets/       # images/attachments
  99-archive/
  templates/
  ```
- Set the attachment folder in Settings so embeds land in `90-assets/`.
- **Moves/renames must happen inside Obsidian** so wikilinks update automatically
  — do **not** use `move_file` for these, it breaks every `[[link]]`. From Desktop
  Commander, only edit *content* (`edit_block` / `write_file`); leave moving and
  renaming to the user in the app.

## Deduplicate & rename

- **Duplicates**: `start_search` titles/aliases to find near-identical notes;
  merge into one, keep the most-linked filename, copy unique content with
  `edit_block`, then `start_search` for inbound `[[links]]` to the discarded note
  and repoint them before deleting it.
- **Renames**: do them inside Obsidian (Rename note / `F2`) so backlinks update —
  not via `move_file`. Keep an `aliases` entry for the old name if it was widely
  referenced.
- Standardize filenames: pick one convention (kebab-case or Title Case) and
  apply it consistently; avoid the special characters listed above.

## Prepare the vault for AI use

- Ensure **consistent frontmatter** (same property names/types) so an agent can
  filter and reason over metadata.
- Maintain a **Home/Index MOC** as the single entry point an agent reads first.
- Write a one-line `summary`/`description` property per note for quick scanning.
- Reduce orphans and broken links so the link graph is a reliable map.
- Keep notes **atomic** (one idea each) — easier for an agent to retrieve and cite.
- Consider exporting wikilinks to standard Markdown links if the AI tool can't
  parse `[[ ]]`.

## Workflows

- **Build navigation**: `write_file` topic MOCs → `edit_block` notes to link them
  in → refresh the Home MOC → convert unlinked mentions.
- **Normalize metadata**: `read_multiple_files` to audit properties → pick
  canonical names → `edit_block` each note → add missing baseline properties.
- **Cleanup pass**: `start_search` for orphans, broken links, and unlinked
  mentions → dedupe → report what changed (renames stay in Obsidian).
- **Dashboard**: confirm Dataview vs. Bases → `write_file` the view from properties/tags.

## Checklist before finishing
- [ ] New/changed notes have consistent frontmatter (canonical property names).
- [ ] Renames/moves done inside Obsidian; no links broken.
- [ ] New notes linked from at least one MOC or note (no new orphans).
- [ ] Tags drawn from the controlled vocabulary.
- [ ] Dashboards reference properties/tags that actually exist.
- [ ] `updated` bumped on changed notes.
