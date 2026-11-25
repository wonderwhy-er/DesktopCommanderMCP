# Local "my shop is down" test: Claude Code (headless) + the fork's Desktop Commander, without vs with device context.
# Run:  powershell -ExecutionPolicy Bypass -File C:\dev\DesktopCommanderMCP\test\device-context\run-local-test.ps1
# Takes ~10-20 min. Results go to test\device-context\local-results\<time>\ (do not commit them)
if ($env:DC_DEV_TOOLS -ne '1') { Write-Host 'Dev-only script: rewrites the DC config and journal (backed up to the results folder) and recreates C:\dev\handmade-shop. Set $env:DC_DEV_TOOLS=1 to run it.'; exit 1 }
$ErrorActionPreference = 'Continue'
$Fork   = 'C:\dev\DesktopCommanderMCP'
$Shop   = 'C:\dev\handmade-shop'
$Kit    = "$Fork\test\device-context"
# The chat runs from an empty temp folder, so the model does not start next to the test kit
$Run    = Join-Path $env:TEMP 'cc-run'
$Out    = Join-Path $Kit ('local-results\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$Prompt = 'my online shop stopped working, can you fix it?'
$Since  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss')
New-Item -ItemType Directory -Force -Path $Out, $Run | Out-Null

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host 'Claude Code (claude) is not in PATH - install it or open a terminal where it works'; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'node is not in PATH'; exit 1 }

Write-Host '== build the fork'
Push-Location $Fork
npm run build 2>&1 | Select-Object -Last 3
Pop-Location
if (-not (Test-Path "$Fork\dist\device-context\card.js")) { Write-Host 'build failed: dist\device-context\card.js missing'; exit 1 }

# Rebuild the device-context journal from DC's own tool history (drops rows recorded by an older build)
$J = Join-Path $env:USERPROFILE '.claude-server-commander\device-context-events.jsonl'
if (Test-Path $J) { Copy-Item $J (Join-Path $Out 'device-context-events.jsonl.backup') -Force }   # never delete the real journal without a copy
Remove-Item $J -ErrorAction SilentlyContinue

function Stop-Shop {
  Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

function Test-ShopStarts {
  # The model's own shop process dies with its DC session, so check whether the shop CAN start now.
  Stop-Shop
  $p = Start-Process -FilePath node -ArgumentList "`"$Shop\server.js`"" -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $status = try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://localhost:3000).StatusCode } catch { 'down' }
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  return $status
}

function Write-McpConfig($mode) {
  $cfg = @{ mcpServers = @{ dc = @{ command = 'node'; args = @("$Fork\dist\index.js");
    env = @{ DESKTOP_COMMANDER_DEVICE_CONTEXT = $mode; DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG = '1'; DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1' } } } }
  $path = Join-Path $Run "mcp-$mode.json"
  $cfg | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii $path
  return $path
}

function Run-Case($mode) {
  Write-Host "== [$mode] restore the shop, then break it (yesterday's chat, through DC)"
  Stop-Shop
  # a fix from the previous run (e.g. a new data/catalog.json) must not leak into this one
  Remove-Item $Shop -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item "$Kit\shop-pristine" $Shop -Recurse -Force
  Push-Location $Fork
  node test\device-context\prior-chat.mjs $Shop 2>&1 | Out-File -Encoding utf8 (Join-Path $Out "prior-$mode.txt")
  Pop-Location
  Start-Sleep -Seconds 5
  $cfg = Write-McpConfig $mode
  Set-Content -Path (Join-Path $Out "start-$mode.txt") -Value (Get-Date).ToUniversalTime().ToString('o')
  Write-Host "== [$mode] new chat: '$Prompt'"
  Push-Location $Run
  # Only Desktop Commander tools: Claude Code's own file/shell tools are switched off so every step goes through DC.
  claude -p $Prompt --output-format json --mcp-config $cfg --strict-mcp-config --allowedTools 'mcp__dc' `
    --disallowedTools 'Bash,Read,Edit,Write,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite' `
    --max-turns 40 2>&1 | Out-File -Encoding utf8 (Join-Path $Out "claude-$mode.json")
  Pop-Location
  Set-Content -Path (Join-Path $Out "end-$mode.txt") -Value (Get-Date).ToUniversalTime().ToString('o')
  $status = Test-ShopStarts
  Set-Content -Path (Join-Path $Out "shop-after-$mode.txt") -Value $status
  Copy-Item "$Shop\.env" (Join-Path $Out "env-after-$mode.txt") -ErrorAction SilentlyContinue
  Write-Host "== [$mode] shop starts after the chat: $status"
}

Run-Case 'off'
Run-Case 'both'

# Only this test's part of DC's logs (calls after the script started), not older history
$dcDir = Join-Path $env:USERPROFILE '.claude-server-commander'
foreach ($f in @('tool-history.jsonl', 'device-context-debug.jsonl')) {
  $src = Join-Path $dcDir $f
  if (Test-Path $src) {
    Get-Content $src | Where-Object { ($_ -match '"(timestamp|t)":"([^"]+)"') -and ($Matches[2] -ge $Since) } |
      Set-Content -Encoding utf8 (Join-Path $Out $f)
  }
}
Write-Host "`nDone. Results: $Out"
