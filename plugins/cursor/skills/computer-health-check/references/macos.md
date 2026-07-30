# macOS command set

All commands here are read-only and run **without sudo**. Verified on macOS 26 / Apple Silicon.

## Collection script (run as one batched process)

Run this with `start_process` (timeout ~30s). It prints labeled sections you can parse.

```bash
zsh -c '
echo "== SYSTEM =="; sw_vers; echo "uptime:"; uptime
echo "== HARDWARE =="; system_profiler SPHardwareDataType 2>/dev/null | grep -Ei "Model Name|Chip|Total Number of Cores|Memory:"
echo "== DISK =="; df -h /
diskutil info / 2>/dev/null | grep -Ei "SMART|Free Space"
echo "== MEMORY =="; vm_stat | head -n 8
echo "swap:"; sysctl -n vm.swapusage
echo "== TOP CPU =="; ps -Ao pid,pcpu,pmem,comm -r | head -n 8
echo "== TOP MEM =="; ps -Ao pid,pcpu,pmem,comm -m | head -n 8
echo "== BATTERY =="; pmset -g batt | head -n 2
system_profiler SPPowerDataType 2>/dev/null | grep -Ei "Cycle Count|Condition|Maximum Capacity"
echo "== THERMAL =="; pmset -g therm 2>/dev/null | head -n 3
echo "== STARTUP =="; echo "user agents:"; ls -1 "$HOME/Library/LaunchAgents" 2>/dev/null
echo "service count: $(launchctl list 2>/dev/null | wc -l | tr -d " ")"
echo "== STORAGE HOTSPOTS =="
for d in "$HOME/Downloads" "$HOME/Library/Caches" "$HOME/.Trash" "$HOME/Library/Logs"; do
  [ -d "$d" ] && printf "%s\t%s\n" "$(du -sh "$d" 2>/dev/null | cut -f1)" "${d/#$HOME/~}"
done
echo "== PACKAGES =="
command -v brew >/dev/null 2>&1 && echo "brew outdated: $(brew outdated 2>/dev/null | wc -l | tr -d " "), cache: $(du -sh "$(brew --cache)" 2>/dev/null | cut -f1)" || echo "brew: not installed"
echo "== CRASH REPORTS =="; ls -1 "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | wc -l
echo "== DONE =="'
```

## How to read it

- **Memory pressure:** page size is 16 KB on Apple Silicon. Healthy = meaningful free+inactive
  pages and near-zero swap "used". If `vm.swapusage` shows hundreds of MB / GB used, that's 🟡/🔴.
- **Battery:** `Maximum Capacity` is the wear indicator; `Condition: Normal` is good. "Service
  Recommended" is 🔴. Skip battery entirely if `pmset -g batt` shows no internal battery (desktop).
- **SMART:** `Verified` = healthy. Anything else → 🔴.
- **Startup:** named third-party `LaunchAgents` are the actionable ones (e.g. updaters, helper
  daemons, redundant DB services). The raw `launchctl` count is mostly Apple system services.

## Optional deeper checks (run only if asked)

```bash
softwareupdate -l 2>&1 | head -n 20         # pending OS updates (network, slow)
networkQuality 2>/dev/null                  # internet up/down + responsiveness (slow)
mdfind 'kMDItemFSSize > 1073741824' 2>/dev/null | head -n 20   # files >1GB, Spotlight-fast
```

## Cleanup commands (suggest; run only on approval)

- **Empty Trash (safe):** `rm -rf "$HOME/.Trash/"*` — or tell the user to empty it from Finder.
- **Homebrew (safe):** `brew cleanup` (removes old versions + cache). Upgrade: `brew upgrade`.
- **User caches (safe, regenerate):** clear specific large subfolders of `~/Library/Caches/<app>`
  — review with `du -sh ~/Library/Caches/* | sort -rh | head` first; never blanket-delete.
- **Login items (user action):** System Settings → General → Login Items, or remove the specific
  `~/Library/LaunchAgents/<name>.plist` only if the user confirms they don't want it.
- **OS updates (user action, needs restart):** System Settings → General → Software Update.
