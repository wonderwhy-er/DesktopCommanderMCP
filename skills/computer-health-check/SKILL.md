---
name: computer-health-check
version: 0.1.0
audience: agent
description: >-
  Run a comprehensive, read-only health check on the user's computer and return a
  scored chat summary with prioritized, plain-English recommendations and safe cleanup
  suggestions. Use this whenever the user wants to check their computer's health, speed
  it up, free up / reclaim disk space, find what's eating CPU / memory / storage, check
  battery health and wear, audit login & startup items, see pending updates, or asks for
  a "tune-up", "checkup", "system report", "health check", or "is my Mac/PC/laptop
  healthy". Trigger even on casual phrasing like "my laptop feels slow", "why is my fan
  so loud", "my computer is laggy", "running out of space", or "clean up my machine".
  Works on macOS, Windows, and Linux. This is a Desktop Commander skill: it relies on a
  real local shell (start_process / interact_with_process) and is strictly read-only by
  default — it never needs sudo and only performs cleanups the user explicitly approves.
---

# Computer Health Check

## What this skill does

Give the user a fast, trustworthy picture of their computer's health and a short list
of actions worth taking — the way a good technician would: look first, explain plainly,
fix only with permission.

It runs entirely through Desktop Commander's local shell, gathers a batch of **read-only**
diagnostics, scores each area, prints a concise summary **in the chat**, and then offers
cleanup suggestions the user can approve one by one.

## The safety contract (read this first)

This is the part that makes users trust the skill, so honor it strictly:

- **Read-only by default.** The collection phase only *observes* (sizes, counts, status).
  It changes nothing.
- **Never use `sudo` or elevation.** DC blocks `sudo`, `shutdown`, `reboot`, `dd`, `mount`,
  `mkfs`, `diskpart`, etc. for good reason. Every check below is designed to work without
  them. If something seems to need elevation, skip it and say so — don't try to work around
  the block.
- **Cleanups are opt-in.** You may *suggest* cleanups freely, but only *execute* one after
  the user explicitly approves that specific action, and only show the exact command first.
- **Prefer reversible, non-destructive actions.** Emptying caches that regenerate, clearing
  a package-manager download cache, or emptying Trash are fine to offer. Deleting user
  documents, uninstalling apps, or editing system files are not — suggest those, let the
  user do them.

## Workflow

### Step 1 — Detect the OS

Determine the platform before doing anything else, because the commands differ.

- Quickest: read Desktop Commander's config (`get_config`) and use the
  `systemInfo.isMacOS` / `isWindows` / `isLinux` booleans (or `platformName`) to
  pick the platform.
- Or run `uname` (macOS/Linux) — if it fails, assume Windows.

Then open the matching reference file and use its command set:

- macOS → [`references/macos.md`](references/macos.md)
- Windows → [`references/windows.md`](references/windows.md)
- Linux → [`references/linux.md`](references/linux.md)

Read **only** the one that matches. Each file contains a single batched collection script
plus interpretation notes and cleanup commands.

### Step 2 — Collect (read-only)

Run the batched collection script from the reference file with `start_process`. Batching
everything into one call is much faster than many small calls and keeps the output tidy.

Guidance:
- Keep outputs bounded (`head`, `Select-Object -First`, etc.) so a long process list or
  file listing doesn't flood the response.
- Skip the genuinely slow / network checks (full OS-update list, internet speed test) on the
  first pass unless the user asked about updates or network. Mention they're available.
- If a single command errors (e.g., a tool isn't installed), continue — partial data is fine.

### Step 3 — Score each area

Rate each category 🟢 Good / 🟡 Watch / 🔴 Act using the rubric below, then compute a simple
overall score. Start at 100 and subtract 8 per 🟡 and 18 per 🔴; floor at 0. Report the
number and a one-word verdict (90+ Excellent, 75–89 Good, 60–74 Fair, <60 Needs attention).

| Area | 🟢 Good | 🟡 Watch | 🔴 Act |
|---|---|---|---|
| Free disk space | >20% free | 10–20% | <10% |
| Disk health (SMART) | Verified / OK / PASSED | — | failing / not supported & errors present |
| Memory pressure | low swap, free pages healthy | noticeable swap/compression | heavy swapping, near-zero free |
| Battery (laptops) | ≥80% max capacity, Normal | 70–80% | <70% or "Service/Replace" |
| Maintenance | uptime <7d, no pending updates | uptime 7–30d or minor updates | uptime >30d or security updates pending |
| Startup load | few third-party login items | moderate | many heavy third-party agents |
| Live resource hogs | nothing >50% at idle | one sustained heavy process | multiple / runaway processes |

Battery is laptop-only — skip it on desktops/VMs. Reclaimable space is reported as an
informational figure, not scored.

### Step 4 — Report in the chat

Use this exact structure. Keep it tight and scannable — this is the deliverable.

```
🖥️  Health Check — <Model>, <OS version>     Score: <N>/100 (<verdict>)

🟢/🟡/🔴  Storage      — <free> free of <total> (<%>). Reclaimable: ~<X> GB
🟢/🟡/🔴  Memory       — <one-line state>
🟢/🟡/🔴  Battery      — <cycles> cycles, <max capacity>%, <condition>
🟢/🟡/🔴  Maintenance  — up <days>d, <updates state>
🟢/🟡/🔴  Startup      — <count> login items (<notable ones>)
🟢/🟡/🔴  Right now    — top: <proc> <cpu%>, <proc> <cpu%>

Top recommendations
1. <highest-impact action> (<expected benefit, e.g. frees ~13 GB>)
2. <next>
3. <next>
```

List at most the 3–5 highest-impact recommendations, ordered by benefit. Don't dump every
finding — the goal is signal, not a wall of text.

### Step 5 — Suggest cleanups, execute only on approval

For each recommendation that maps to a concrete command (see the reference file's "Cleanup"
section), offer it and show the exact command. Then:

- **Safe, reversible** (offer to run on a yes): empty Trash, package-manager cache cleanup
  (`brew cleanup`, `npm cache clean`), clearing a regenerating user cache folder. (On Linux,
  `apt-get clean` / `dnf clean` need root — suggest, don't auto-run.)
- **Needs the user to decide / act** (suggest, don't auto-run): disabling login items,
  installing OS updates (requires restart), uninstalling apps, deleting files in Downloads.
- **Never**: anything requiring sudo/admin, removing system files, disk/partition operations.

When the user approves a safe action, run it, then report what changed (e.g., space freed).
Re-running Step 2's storage check afterward is a nice confirmation.

## Recommendation rules (findings → advice)

These are the high-value mappings; adapt the wording to the platform.

- **Uptime > 30 days** → "Restart your computer — it's been up <N> days. A reboot clears
  memory and applies pending updates." (Highest ROI, lowest effort.)
- **Pending OS/security updates** → platform update step; flag security updates as higher
  priority.
- **Free space < 15%** → lead with the biggest reclaimable buckets you measured.
- **Large Downloads / Caches / Trash** → empty Trash; review largest Downloads items by name;
  clear caches that regenerate.
- **Package manager has many outdated items / big cache** → `upgrade` + cache cleanup.
- **Battery max capacity < 80%** → explain wear is normal; consider a battery service if it's
  affecting runtime.
- **Many third-party startup agents** → name them and suggest disabling the ones the user
  doesn't recognize/need (point to System Settings / Task Manager — don't edit them directly).
- **A process pinned high at idle** → name it and suggest quitting/investigating.

## Notes & pitfalls

- **Don't assume — measure.** Always run the commands and report real numbers. Never
  fabricate sizes, cycle counts, or statuses.
- **Bounded output.** Process and file listings can be huge; always cap them.
- **Optional deep checks** (mention, run on request): internet speed test, full update list,
  per-folder disk scan of the whole home directory, crash-report trend analysis.
- **Privacy.** This reads local system metadata only. Don't send anything off the machine;
  the public-IP check is optional and should be labeled.
- **Cross-platform parity.** The three reference files mirror the same categories so the
  report looks the same regardless of OS.
