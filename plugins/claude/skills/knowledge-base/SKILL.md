---
name: knowledge-base
version: 0.1.0
audience: agent
description: >-
  Create and maintain a Markdown knowledge base that any AI agent can read,
  search, and update. Use when the user wants to start a knowledge base, add or
  update notes, organize docs/notes for an agent or LLM to consume, build an
  index of notes, or run a cleanup/maintenance pass on an existing MD knowledge
  base. Triggers include "knowledge base", "KB", "notes for the agent", "index
  of notes", "second brain", "docs for AI context", "add a note", "update the
  KB".
---

# Knowledge Base (Markdown, agent-readable)

A knowledge base (KB) here is a folder of Markdown files designed so **any** AI
agent can navigate it without a vector database: the agent reads one index file,
picks the relevant notes by their descriptions, and opens only those. Keep the
whole KB readable and the index lean — the index is what gets loaded into
context, so it must be high-signal.

Apply the rules below when creating a new KB, adding/editing notes, or doing a
maintenance pass. When the user's request is ambiguous (new KB vs. add note vs.
cleanup), ask which one before acting.

## Core principles (the "why")

1. **Index-first navigation.** The index is a map, not a container. An agent
   reads `INDEX.md`, selects notes by their one-line descriptions, then opens
   only those files. No note is "in" the KB unless it's registered in the index.
2. **Atomicity.** One topic per note. If a title needs an "and", it's probably
   two notes. Atomic notes are easier to find, link, and reuse.
3. **Stable IDs.** Every note has a permanent ID that never changes and is never
   reused, so links survive renames and moves.
4. **Linked with reason.** When two notes connect, state *why* (prerequisite,
   supports, contrasts, see-also). Connections carry as much value as the notes.
5. **Lean instructions.** Keep `INDEX.md` instructions short and high-signal —
   it competes for the agent's context budget. Bodies load on demand.
6. **Structured for retrieval.** Clear H1 title and H2/H3 sections so an agent
   can grab the relevant slice of a note, not the whole thing.

## Folder structure (nested by topic)

```
knowledge-base/
  INDEX.md                 # entry point: instructions + full note registry
  topics/
    <topic>/
      _topic.md            # topic map: what this topic covers + its notes
      <slug>.md            # one atomic note
  assets/                  # images / attachments referenced by notes
```

- Topic folders are short, lowercase nouns (`auth`, `billing`, `deploys`).
- `_topic.md` is the topic-level map of content (MOC): a short intro plus links
  to every note in that topic. It is a convenience view; `INDEX.md` remains the
  source of truth.

## Naming rules

- Lowercase **kebab-case**, predictable and greppable: `topics/auth/session-tokens.md`.
- No spaces, no uppercase, no dates in filenames (dates live in frontmatter).
- The filename slug should match the note's `id` slug portion.

## Required frontmatter (every note)

```yaml
---
id: 20260618-session-tokens     # ID scheme: YYYYMMDD-slug. Stable. Never reuse or change.
title: Session tokens           # human title, also the note's H1
tags: [auth, security]          # only tags from the controlled list in INDEX.md
created: 2026-06-18
updated: 2026-06-18
related: [20260618-auth-flow]    # IDs of linked notes
summary: One scannable sentence describing what this note covers.
---
```

- `id`: `YYYYMMDD-slug`. Sortable, readable, stable. Different-titled same-day
  notes differ by slug; if two same-day notes would collide on the same slug,
  append `-2`, `-3`, … (check the `INDEX.md` registry before assigning). Once
  assigned, the id is permanent.
- `summary`: this exact sentence is what goes in the index registry — write it to
  help an agent decide whether to open the note.
- `updated`: bump it whenever the body changes.

## Note body shape

```markdown
# Session tokens

> Summary: One sentence (mirrors frontmatter summary).

## Context
Why this note exists / when it applies.

## Details
The actual content, in short H2/H3 sections.

## Related
- [Auth flow](auth-flow.md) — prerequisite: tokens are issued during the auth flow.
- [Rate limiting](../api/rate-limiting.md) — see-also: tokens carry the rate-limit key.
```

- Use **relative links** between notes and annotate the relationship in a phrase.
- Every link target should also appear in the note's `related` frontmatter.

## INDEX.md (the single source of truth)

`INDEX.md` has two parts: operating instructions for agents, and the registry.

```markdown
# Knowledge Base — Index

## How to use this KB (for agents)
1. Read this index first. Pick notes by their descriptions; open only those.
2. To answer a question, prefer opening 1–3 specific notes over scanning everything.
3. Cite the note `id` when you use information from it.

## How to update this KB (for agents)
- New idea → create a new note (atomic). Same idea changed → edit the note in place and bump `updated`.
- Any create / rename / delete MUST update this registry and the topic's `_topic.md` in the same change.
- Use only tags from the controlled vocabulary below; add a new tag here before using it.

## Controlled tags
`auth`, `security`, `billing`, `api`, `ops`   <!-- extend deliberately -->

## Registry
### auth
- `20260618-auth-flow` — **Authentication flow** — `topics/auth/auth-flow.md` — How a user session is established end to end.
- `20260618-session-tokens` — **Session tokens** — `topics/auth/session-tokens.md` — Token format, lifetime, and rotation.

### billing
- `20260618-invoicing` — **Invoicing** — `topics/billing/invoicing.md` — How invoices are generated and sent.
```

Registry line format: `` `id` — **Title** — `path` — one-line description.``

## _topic.md (topic map)

```markdown
# Auth

Notes covering authentication, sessions, and access control.

- [Authentication flow](auth-flow.md) — how a session is established.
- [Session tokens](session-tokens.md) — token format, lifetime, rotation.
```

## Workflows

### Create a new KB
1. `create_directory` for the folder structure above.
2. `write_file` `INDEX.md` with the instructions block, an empty controlled-tag
   list, and an empty registry.
3. Add the first topic folder + `_topic.md`, then the first note (each via `write_file`).
4. Register the note in `INDEX.md` and link it from `_topic.md` — `edit_block`
   both so you touch only the changed lines.

### Add a note
1. Pick or create the topic folder (`list_directory` to see what's there).
2. `write_file` the note (kebab-case slug) with full frontmatter and the body shape.
3. Add cross-links (and mirror them in `related`).
4. Register it in `INDEX.md` and link it in `_topic.md` with `edit_block` — same change.

### Update a note
- Same idea, new information → `edit_block` the note in place, bump `updated`, and
  `edit_block` the registry line if the scope changed.
- Genuinely new idea → `write_file` a new atomic note instead of expanding this one.

### Maintenance pass (run on demand)
Use `start_search` (ripgrep) for text scans and `get_file_info` / `list_directory`
for existence checks — together they make this tractable at scale:
- **Orphans** (no *inbound* links — outbound doesn't matter): `start_search` the
  KB for the note's `id` and filename slug, then discount the self-matches that
  always exist — the note's own file, `INDEX.md`, and its `_topic.md`. Anything
  left is a genuine inbound reference; nothing left = orphan, so link it from a
  relevant note/MOC or archive it.
- **Broken links / drift**: don't infer resolution from a text hit — a string
  existing doesn't mean the file does. Confirm each registry path and `related:`
  target exists with `get_file_info` (or `list_directory` per topic), and that
  every file on disk is registered. Use a text compare only for the
  titles/summaries-out-of-sync half.
- **Non-atomic notes**: notes that grew to cover multiple topics → split them.
- **Duplicates**: near-identical notes → merge, keep one `id`, redirect links.
- **Tag sprawl**: read the controlled list from `INDEX.md`, then `start_search`
  the frontmatter `tags:` lines and flag any tag not on the list → reconcile.
Pull candidates in bulk with `read_multiple_files`, apply fixes with `edit_block`,
and report what changed.

## Checklist before finishing any KB edit
- [ ] Every new/changed note has complete, valid frontmatter.
- [ ] `id` is unique and unchanged; filename slug matches the id slug.
- [ ] All links resolve and are mirrored in `related`.
- [ ] `INDEX.md` registry and the topic `_topic.md` reflect the change.
- [ ] Tags are from the controlled vocabulary.
- [ ] `updated` bumped on every changed note.
