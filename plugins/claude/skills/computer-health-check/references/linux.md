# Linux command set

Read-only diagnostics, **no sudo**. Targets common distros (Debian/Ubuntu, Fedora, Arch). Some
tools (`smartctl`, `upower`) may be absent or need root for full detail — degrade gracefully.

## Collection script (run as one batched process)

```bash
bash -c '
echo "== SYSTEM =="; (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"); uname -r; uptime -p 2>/dev/null || uptime
echo "== HARDWARE =="; echo "CPUs: $(nproc)"; grep -m1 "model name" /proc/cpuinfo | cut -d: -f2 | sed "s/^ //"
echo "== DISK =="; df -h / /home 2>/dev/null | grep -v tmpfs
echo "== DISK HEALTH =="; lsblk -d -o NAME,SIZE,ROTA,MODEL 2>/dev/null
echo "== MEMORY =="; free -h
echo "swap:"; swapon --show 2>/dev/null || echo "none"
echo "== TOP CPU =="; ps -eo pid,pcpu,pmem,comm --sort=-pcpu | head -n 8
echo "== TOP MEM =="; ps -eo pid,pcpu,pmem,comm --sort=-rss | head -n 8
echo "== BATTERY =="; for b in /sys/class/power_supply/BAT*; do [ -d "$b" ] && { echo "capacity: $(cat $b/capacity 2>/dev/null)%"; echo "health: $(cat $b/health 2>/dev/null)"; cf=$(cat $b/charge_full 2>/dev/null); cd=$(cat $b/charge_full_design 2>/dev/null); [ -n "$cf" ] && [ -n "$cd" ] && echo "wear: $((100*cf/cd))% of design"; }; done
echo "== STARTUP =="; echo "enabled user services: $(systemctl --user list-unit-files --state=enabled 2>/dev/null | grep -c enabled)"; ls -1 "$HOME/.config/autostart" 2>/dev/null
echo "== STORAGE HOTSPOTS =="
for d in "$HOME/Downloads" "$HOME/.cache" "$HOME/.local/share/Trash"; do
  [ -d "$d" ] && printf "%s\t%s\n" "$(du -sh "$d" 2>/dev/null | cut -f1)" "${d/#$HOME/~}"
done
echo "== PACKAGES =="
if command -v apt >/dev/null 2>&1; then echo "apt upgradable: $(apt list --upgradable 2>/dev/null | grep -c upgradable)"
elif command -v dnf >/dev/null 2>&1; then echo "dnf updates: $(dnf check-update -q 2>/dev/null | grep -c .)"
elif command -v pacman >/dev/null 2>&1; then echo "pacman updates: $(checkupdates 2>/dev/null | wc -l)"; fi
echo "== DONE =="'
```

## How to read it

- **Memory:** `free -h` — focus on the `available` column (real headroom) and whether swap `used`
  is climbing. High swap use with low available = 🟡/🔴.
- **Disk health:** `lsblk` confirms devices; full SMART needs `sudo smartctl -H /dev/sdX` (skip —
  needs root). Report SMART as "not available without elevation" rather than guessing.
- **Battery:** the `charge_full / charge_full_design` ratio is the wear %. Skip if no `BAT*`.
- **Startup:** `~/.config/autostart` and enabled `--user` units are the actionable third-party items.

## Optional deeper checks (run only if asked)

```bash
journalctl -p 3 -b --no-pager | tail -n 30     # recent boot errors (may need group access)
du -xh "$HOME" 2>/dev/null | sort -rh | head -n 15   # biggest dirs in home
ping -c 4 8.8.8.8                               # connectivity
```

## Cleanup commands (suggest; run only on approval)

- **Empty Trash (safe):** `rm -rf "$HOME/.local/share/Trash/"*`.
- **User cache (safe, regenerates):** review `du -sh ~/.cache/* | sort -rh | head` then clear
  specific large entries; avoid blanket deletion.
- **Package cache (user action; usually needs sudo):** `apt-get clean`, `dnf clean all`, or
  `pacman -Sc` — note these typically require root, so suggest rather than run.
- **Updates (user action; needs sudo):** `apt upgrade` / `dnf upgrade` / `pacman -Syu`.
- **Startup items (user action):** remove `.desktop` files from `~/.config/autostart`, or
  `systemctl --user disable <unit>`.
