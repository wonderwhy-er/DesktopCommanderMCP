# Claude Desktop test of device context: build the fork, break the shop ("yesterday's chat"),
# add the fork's DC to Claude Desktop as "dc-fork". Then quit Claude Desktop from the tray, open it, new chat:
#   "my online shop stopped working, can you fix it?"
# Run:  powershell -ExecutionPolicy Bypass -File C:\dev\DesktopCommanderMCP\test\device-context\claude-desktop-setup.ps1 [-Mode both|off]
param([ValidateSet('both', 'off')] [string]$Mode = 'both')
# Dev-only: rewrites Claude Desktop's config (backed up first), recreates C:\dev\handmade-shop, writes the mode file
if ($env:DC_DEV_TOOLS -ne '1') { Write-Host 'Dev-only script: rewrites the Claude Desktop config (with a backup), recreates C:\dev\handmade-shop and writes the device-context mode file. Set $env:DC_DEV_TOOLS=1 to run it.'; exit 1 }
# Continue: in Windows PowerShell, 'Stop' turns npm/node warnings on stderr (2>&1) into terminating errors
$ErrorActionPreference = 'Continue'
$Fork = 'C:\dev\DesktopCommanderMCP'
$Shop = 'C:\dev\handmade-shop'

Write-Host '== build the fork'
Push-Location $Fork
npm run build 2>&1 | Select-Object -Last 2
if (-not (Test-Path "$Fork\dist\device-context\card.js")) { throw 'build failed: dist\device-context\card.js missing' }

Write-Host "== restore the shop and break it (yesterday's chat through DC)"
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
if (Test-Path $Shop) { Remove-Item $Shop -Recurse -Force }
Copy-Item "$Fork\test\device-context\shop-pristine" $Shop -Recurse -Force
node test\device-context\prior-chat.mjs $Shop 2>&1 | Select-Object -Last 3
Pop-Location

# Claude Desktop keeps its config here; the Microsoft Store build keeps it inside its package folder
$targets = @("$env:APPDATA\Claude\claude_desktop_config.json")
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue |
  ForEach-Object { $targets += Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json' }

$node = (Get-Command node).Source
$server = [pscustomobject]@{
  command = $node
  args    = @("$Fork\dist\index.js")
  env     = [pscustomobject]@{
    DESKTOP_COMMANDER_DEVICE_CONTEXT       = $Mode
    DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG = '1'
    DESKTOP_COMMANDER_DISABLE_TELEMETRY    = '1'
  }
}

foreach ($p in $targets) {
  $dir = Split-Path $p
  if (-not (Test-Path $dir)) { continue }   # this kind of install is not on the machine
  $cfg = [pscustomobject]@{}
  if ((Test-Path $p) -and (Get-Content $p -Raw).Trim()) {
    Copy-Item $p "$p.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    try { $cfg = Get-Content $p -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { Write-Host "!! $p is not valid JSON, left as is (backup next to it). Fix it or add dc-fork by hand."; continue }
  }
  if (-not $cfg.PSObject.Properties['mcpServers']) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
  foreach ($old in @($cfg.mcpServers.PSObject.Properties.Name | Where-Object { $_ -like 'dc-fork-*' })) { $cfg.mcpServers.PSObject.Properties.Remove($old) }
  $cfg.mcpServers | Add-Member -NotePropertyName 'dc-fork' -NotePropertyValue $server -Force
  # UTF-8 without BOM: a BOM breaks JSON parsing in Node
  [IO.File]::WriteAllText($p, ($cfg | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "== dc-fork written to $p"
}
# Claude Desktop keeps a server's env from when it was first added and ignores later config edits,
# so the mode goes into a file that DC reads at start (it wins over the env var)
$modeFile = Join-Path $env:USERPROFILE '.claude-server-commander\device-context-mode'
[IO.File]::WriteAllText($modeFile, $Mode, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "== mode file: $modeFile = $Mode"
Write-Host ''
Write-Host "Now: quit Claude Desktop from the tray icon (Quit), open it again, check Settings > Desktop app > Extensions shows dc-fork running (in the chat, keep Remote Desktop Commander off),"
Write-Host 'then in a NEW chat: my online shop stopped working, can you fix it?'
