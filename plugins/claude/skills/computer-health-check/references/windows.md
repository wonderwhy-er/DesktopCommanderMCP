# Windows command set

Read-only diagnostics via PowerShell. None require admin. Run through `start_process` with
`powershell -NoProfile -Command "..."` (or `pwsh`). Keep outputs bounded with `Select-Object`.

## Collection script (run as one batched process)

```powershell
powershell -NoProfile -Command "
Write-Output '== SYSTEM =='; (Get-CimInstance Win32_OperatingSystem | Select Caption,Version,LastBootUpTime | Format-List | Out-String).Trim()
Write-Output '== HARDWARE =='; (Get-CimInstance Win32_ComputerSystem | Select Manufacturer,Model,@{n='RAM_GB';e={[math]::Round($_.TotalPhysicalMemory/1GB,1)}} | Format-List | Out-String).Trim()
Write-Output '== DISK =='; Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '{0} {1}% free ({2:N1} of {3:N1} GB)' -f \$_.DeviceID, [math]::Round(\$_.FreeSpace/\$_.Size*100), (\$_.FreeSpace/1GB), (\$_.Size/1GB) }
Write-Output '== DISK HEALTH =='; (Get-PhysicalDisk | Select FriendlyName,HealthStatus,OperationalStatus | Format-Table -Auto | Out-String).Trim()
Write-Output '== MEMORY =='; \$os=Get-CimInstance Win32_OperatingSystem; '{0:N1} GB free of {1:N1} GB' -f (\$os.FreePhysicalMemory/1MB),(\$os.TotalVisibleMemorySize/1MB)
Write-Output '== TOP CPU =='; (Get-Process | Sort CPU -Desc | Select -First 8 Name,CPU,@{n='MB';e={[math]::Round(\$_.WS/1MB)}} | Format-Table -Auto | Out-String).Trim()
Write-Output '== TOP MEM =='; (Get-Process | Sort WS -Desc | Select -First 8 Name,@{n='MB';e={[math]::Round(\$_.WS/1MB)}} | Format-Table -Auto | Out-String).Trim()
Write-Output '== BATTERY =='; (Get-CimInstance Win32_Battery | Select EstimatedChargeRemaining,BatteryStatus | Format-List | Out-String).Trim()
Write-Output '== STARTUP =='; (Get-CimInstance Win32_StartupCommand | Select Name,Location | Format-Table -Auto | Out-String).Trim()
Write-Output '== STORAGE HOTSPOTS =='; \$d=\$env:USERPROFILE; foreach(\$p in 'Downloads','AppData\Local\Temp'){ \$f=Join-Path \$d \$p; if(Test-Path \$f){ \$s=(Get-ChildItem \$f -Recurse -EA SilentlyContinue | Measure Length -Sum).Sum; '{0:N1} GB  {1}' -f (\$s/1GB), \$p } }
Write-Output '== PACKAGES =='; if(Get-Command winget -EA SilentlyContinue){ (winget upgrade 2>\$null | Measure-Object -Line).Lines } else { 'winget: n/a' }
Write-Output '== DONE =='
"
```

## How to read it

- **Battery health detail:** the deep wear report needs `powercfg /batteryreport` (writes an HTML
  file to disk) — run only on request, then read the generated file. `Win32_Battery` gives charge
  %, not wear. Skip battery on desktops (no `Win32_Battery` instance).
- **Disk health:** `HealthStatus = Healthy` is 🟢; `Warning`/`Unhealthy` is 🔴.
- **Memory:** compare free vs total; sustained <10% free under load is 🟡/🔴. Pagefile thrash shows
  up as high disk + low free RAM.
- **Startup:** `Win32_StartupCommand` plus the Run registry keys are the actionable third-party items.
- **Packages:** the winget value is a raw output-line count, not an exact upgrade count — read it as "updates pending or not," and run `winget upgrade` for the real list.

## Optional deeper checks (run only if asked)

```powershell
powercfg /batteryreport /output "$env:TEMP\battery.html"   # then read the file for wear %
Get-WindowsUpdate                                          # if PSWindowsUpdate module present
Test-Connection -Count 4 8.8.8.8                           # basic connectivity
```

## Cleanup commands (suggest; run only on approval)

- **Empty Recycle Bin (safe):** `Clear-RecycleBin -Force` (PowerShell).
- **Temp files (safe, regenerate):** remove contents of `$env:TEMP` — show size first with
  `(Get-ChildItem $env:TEMP -Recurse -EA SilentlyContinue | Measure Length -Sum).Sum/1GB`.
- **Package upgrades (user action):** `winget upgrade --all` (may prompt / need elevation per app).
- **Startup items (user action):** Task Manager → Startup tab, or Settings → Apps → Startup.
- **Windows updates (user action, needs restart):** Settings → Windows Update.
- **Disk Cleanup (user action):** `cleanmgr` for system-level reclaim.
