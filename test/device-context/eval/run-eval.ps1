# Device-context eval on this PC: Claude Code (headless) + the fork's Desktop Commander.
# Several arms (with/without memory and fair baselines), N runs each, graded automatically.
#   powershell -ExecutionPolicy Bypass -File C:\dev\DesktopCommanderMCP\test\device-context\eval\run-eval.ps1 [-Runs 3] [-Arms "A,B,C,D,E,F,G1,G2"]
# Before running: close Claude Desktop and any other app that uses Desktop Commander, and close Explorer windows
# or terminals that are inside C:\dev\DesktopCommanderMCP\test.
# Results: test\device-context\eval\results\<time>\summary.md  (do not commit)
# Your real DC files (history, journal, debug log, config) are backed up first and restored at the end.
param([int]$Runs = 3, [string]$Arms = 'A,B,C,D,E,F,G1,G2')
if ($env:DC_DEV_TOOLS -ne '1') { Write-Host 'Dev-only script: recreates test projects in C:\dev and temporarily replaces your DC history, journal and config (backed up and restored). Set $env:DC_DEV_TOOLS=1 to run it.'; exit 1 }
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # read claude's UTF-8 output correctly
foreach ($c in @('claude', 'node', 'npm')) { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Write-Host "$c is not in PATH"; exit 1 } }

$Fork    = 'C:\dev\DesktopCommanderMCP'
$Root    = 'C:\dev'                                 # where the test projects live
$KitHome = "$Fork\test\device-context"
# While the eval runs, the whole test folder (scripts, pristine copies, old results) is moved out of C:\dev,
# so a model searching C:\dev for "shop" cannot find the test kit. It is moved back at the end.
$Work  = 'C:\ProgramData\dc-eval'
$Kit   = "$Work\device-context\eval"
$Tmp   = Join-Path $env:TEMP 'cc-run'               # empty start folder for most arms
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out   = Join-Path $Kit ('results\' + $Stamp)
$DcDir = Join-Path $env:USERPROFILE '.claude-server-commander'
$Hist  = Join-Path $DcDir 'tool-history.jsonl'
$Jrnl  = Join-Path $DcDir 'device-context-events.jsonl'
$Dbg   = Join-Path $DcDir 'device-context-debug.jsonl'
$Cfg   = Join-Path $DcDir 'config.json'
$Ccp   = Join-Path $env:USERPROFILE '.claude\projects'   # Claude Code's own transcripts of each run
$Utf8  = New-Object System.Text.UTF8Encoding($false)
$Names = 'handmade-shop', 'shop-old', 'travel-blog'
$Extra = 'clayco-shop', 'clay-shop'   # created only by the twin / stale variants

$P       = 'my online shop stopped working, can you fix it?'
$PHint   = 'my online shop stopped working after we changed something in it a couple of days ago, can you fix it?'
$POracle = 'my online shop in C:\dev\handmade-shop stopped working, can you fix it?'
$PBlog   = 'please add a short post about Lisbon to my travel blog'
# arm = mode, start folder, prompt, task
$ArmDefs = @{
  'A'  = @('off',   $Tmp,  $P,       'shop')   # no memory, nothing around: the old baseline
  'B'  = @('off',   $Root, $P,       'shop')   # no memory, started next to the projects: realistic exploring
  'C'  = @('off',   $Tmp,  $PHint,   'shop')   # no memory, prompt hints at earlier work: invites the history tool
  'D'  = @('both',  $Tmp,  $P,       'shop')   # memory: get_device_context + card + compact history
  'E'  = @('nudge', $Tmp,  $P,       'shop')   # memory without the tool (what ChatGPT could get)
  'F'  = @('off',   $Tmp,  $POracle, 'shop')   # path given: lower bound
  'G1' = @('off',   $Tmp,  $PBlog,   'blog')   # unrelated task, no memory
  'G2' = @('both',  $Tmp,  $PBlog,   'blog')   # unrelated task, memory: overhead / misleading?
  'H'  = @('both',  $Tmp,  $P,       'shop', 'twin')    # memory, plus a second live shop with the same description, worked on last
  'S'  = @('both',  $Tmp,  $P,       'shop', 'stale')   # memory, but the shop folder was renamed after the break (memory is stale)
  'S0' = @('off',   $Root, $P,       'shop', 'stale')   # same rename, no memory, started next to the projects
}

# Ports the test servers use must be free (we stop whatever listens there between runs)
$busy = foreach ($port in 3000, 3001, 4000) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue }
if ($busy) { Write-Host 'Something already listens on 3000/3001/4000. Stop it (or an earlier test server) and rerun.'; exit 1 }

# Move the kit out of C:\dev. Our own location must not be inside it.
Set-Location $env:TEMP; [Environment]::CurrentDirectory = $env:TEMP
if (Test-Path $Work) { Write-Host "$Work exists (an earlier run did not finish?). Move $Work\device-context back to $KitHome or delete $Work, then rerun."; exit 1 }
New-Item -ItemType Directory -Force -Path $Work | Out-Null
try { Move-Item $KitHome (Join-Path $Work 'device-context') -ErrorAction Stop }
catch { Write-Host "Cannot move $KitHome (a window or terminal open in it?): $_"; Remove-Item $Work -Force -ErrorAction SilentlyContinue; exit 1 }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$total = 0
$backedUp = $false
try {
  # Back up your real DC files first: nothing below may touch them before this
  foreach ($f in @($Hist, $Jrnl, $Dbg, $Cfg)) { if (Test-Path $f) { Copy-Item $f (Join-Path $Out ((Split-Path $f -Leaf) + '.original')) -ErrorAction Stop } }
  # a device-context-mode file (set for Claude Desktop) would override every arm's mode: park it during the runs
  $ModeFile = Join-Path $DcDir 'device-context-mode'
  if (Test-Path $ModeFile) { Move-Item $ModeFile (Join-Path $Out 'device-context-mode.original') -Force }
  $backedUp = $true

  Write-Host '== build the fork'
  Push-Location $Fork; npm run build 2>&1 | Select-Object -Last 2; $rc = $LASTEXITCODE; Pop-Location
  if ($rc -ne 0 -or -not (Select-String -LiteralPath "$Fork\dist\device-context\index.js" -Pattern 'compactHistoryText' -Quiet)) { throw 'build failed or dist is stale' }

  # Clean base history: your real one minus earlier test runs and minus the last 36 h
  # (so the scripted "1 day ago" session really is the latest work)
  $HistBase = Join-Path $Out 'tool-history.base.jsonl'
  $cut = (Get-Date).ToUniversalTime().AddHours(-36).ToString('yyyy-MM-ddTHH:mm:ss')
  $lines = @()
  if (Test-Path $Hist) {
    $lines = @([IO.File]::ReadAllLines($Hist, $Utf8) | Where-Object {
      ($_ -notmatch '(?i)handmade-shop|shop-old|travel-blog|clayco-shop|clay-shop|cc-run|dc-eval|device-context[\\/]+eval|pristine') -and
      (($_ -notmatch '"timestamp":"([^"]+)"') -or ($Matches[1] -lt $cut)) })
  }
  if (-not $lines) { $lines = @() }
  [IO.File]::WriteAllLines($HistBase, [string[]]$lines, $Utf8)

  function Stop-TestProcesses {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match '(?i)handmade-shop|shop-old|travel-blog|clayco-shop|clay-shop' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($port in 3000, 3001, 4000) {
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
  }

  function Reset-State {
    Stop-TestProcesses
    foreach ($p in $Names) {
      $dst = Join-Path $Root $p
      for ($k = 0; $k -lt 5 -and (Test-Path $dst); $k++) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $dst) { Stop-TestProcesses; Start-Sleep 1 } }
      if (Test-Path $dst) { throw "cannot reset $dst (in use?)" }
      Copy-Item (Join-Path "$Kit\pristine" $p) $dst -Recurse
    }
    foreach ($x in $Extra) { $d = Join-Path $Root $x; for ($k = 0; $k -lt 5 -and (Test-Path $d); $k++) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $d) { Stop-TestProcesses; Start-Sleep 1 } } }
    Copy-Item $HistBase $Hist -Force                            # history = your real one, without test runs
    Remove-Item $Jrnl -ErrorAction SilentlyContinue             # journal is rebuilt from it, then the earlier chats are added
    if (Test-Path (Join-Path $Out 'config.json.original')) { Copy-Item (Join-Path $Out 'config.json.original') $Cfg -Force }
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  }

  function Get-TreeHash($d) {
    (Get-ChildItem $d -Recurse -File -Force -ErrorAction SilentlyContinue | Sort-Object FullName |
      ForEach-Object { "$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm MD5).Hash)" }) -join "`n"
  }

  function Test-ShopStarts {
    Stop-TestProcesses
    $port = 3000
    $shopDir = if (Test-Path "$Root\clay-shop") { "$Root\clay-shop" } else { "$Root\handmade-shop" }
    $m = Select-String -LiteralPath "$shopDir\.env" -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue
    if ($m) { $port = [int]$m.Matches[0].Groups[1].Value }
    $p = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $shopDir -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 3
    $status = try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$port").StatusCode } catch { 'down' }
    if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Stop-TestProcesses
    return "$status"
  }

  function Write-McpConfig($mode, $path) {
    $cfg = @{ mcpServers = @{ dc = @{ command = 'node'; args = @("$Fork\dist\index.js");
      env = @{ DESKTOP_COMMANDER_DEVICE_CONTEXT = $mode; DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG = '1'; DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1' } } } }
    $cfg | ConvertTo-Json -Depth 6 | Set-Content -Encoding ascii $path
  }

  $armList = @($Arms.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $ArmDefs.ContainsKey($_) })
  $sideRuns = [Math]::Max(1, [Math]::Floor($Runs * 2 / 3))     # fewer runs for the side task
  for ($i = 1; $i -le $Runs; $i++) {
    $order = @($armList | Get-Random -Count $armList.Count)     # new order each round
    foreach ($arm in $order) {
      if ($arm -like 'G*' -and $i -gt $sideRuns) { continue }
      $mode, $cwd, $prompt, $task, $variant = $ArmDefs[$arm]
      if (-not $variant) { $variant = '' }
      $runDir = Join-Path $Out ("$arm-$i"); New-Item -ItemType Directory -Force -Path $runDir | Out-Null
      $total++
      Write-Host ("== run {0}: arm {1} ({2}, {3})" -f $total, $arm, $mode, $task)
      Reset-State
      $runStart = (Get-Date).ToUniversalTime().ToString('o')
      Push-Location $Fork
      $env:EVAL_VARIANT = $variant
      node "$Kit\history.mjs" $Root 2>&1 | Out-File -Encoding utf8 (Join-Path $runDir 'history.txt')
      $hrc = $LASTEXITCODE
      Pop-Location
      Stop-TestProcesses   # killing a shell leaves its node child running on Windows
      if ($hrc -ne 0) { Write-Host "   skipped: earlier-chat setup incomplete (see $runDir\history.txt)"; continue }
      Start-Sleep -Seconds 2
      $env:EVAL_VARIANT = ''
      $present = @($Names + $Extra | Where-Object { Test-Path (Join-Path $Root $_) })
      $snap = @{}; foreach ($n in $present) { $snap[$n] = Get-TreeHash (Join-Path $Root $n) }
      $cfgPath = Join-Path $runDir 'mcp.json'; Write-McpConfig $mode $cfgPath
      $pre = @(Get-ChildItem $Ccp -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue | ForEach-Object FullName)
      $claudeStart = (Get-Date).ToUniversalTime().ToString('o')
      @{ arm = $arm; mode = $mode; task = $task; variant = $variant; prompt = $prompt; cwd = $cwd; runStart = $runStart; claudeStart = $claudeStart } |
        ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $runDir 'meta.json')
      Push-Location $cwd
      # Only Desktop Commander tools: Claude Code's own file/shell tools are off, so every step goes through DC
      claude -p $prompt --output-format stream-json --verbose --mcp-config $cfgPath --strict-mcp-config --allowedTools 'mcp__dc' `
        --disallowedTools 'Bash,Read,Edit,Write,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite' `
        --max-turns 40 2>&1 | Out-File -Encoding utf8 (Join-Path $runDir 'claude.json')
      Pop-Location
      # Claude Code keeps a transcript per run under ~\.claude\projects: move it here, so later runs cannot find earlier fixes
      Get-ChildItem $Ccp -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue | Where-Object { $pre -notcontains $_.FullName } |
        ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination (Join-Path $runDir ('transcript-' + $_.Name)) -ErrorAction SilentlyContinue }
      Stop-TestProcesses
      Set-Content -Encoding ascii (Join-Path $runDir 'changed.txt') ((@($present | Where-Object { (Get-TreeHash (Join-Path $Root $_)) -ne $snap[$_] })) -join ',')
      $shopEnv = if (Test-Path "$Root\clay-shop") { "$Root\clay-shop\.env" } else { "$Root\handmade-shop\.env" }
      Copy-Item $shopEnv (Join-Path $runDir 'shop-env-after.txt') -ErrorAction SilentlyContinue
      Set-Content -Encoding ascii (Join-Path $runDir 'shop-status.txt') (Test-ShopStarts)
      $lisbon = Get-ChildItem "$Root\travel-blog\posts" -Filter *.md -File -ErrorAction SilentlyContinue |
        Where-Object { Select-String -LiteralPath $_.FullName -Pattern 'Lisbon' -Quiet }
      Set-Content -Encoding ascii (Join-Path $runDir 'blog-check.txt') ($(if ($lisbon) { 'yes' } else { 'no' }))
      node "$Kit\grade.mjs" slice $runDir $runStart | Out-Null
    }
  }

  Write-Host "`n== summary"
  node "$Kit\grade.mjs" summary $Out
} finally {
  # Always: put your real DC files back, stop test servers, move the kit back
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '(?i)handmade-shop|shop-old|travel-blog' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($backedUp) {   # only touch your DC files if the backup was made
    $mb = Join-Path $Out 'device-context-mode.original'; if (Test-Path $mb) { Move-Item $mb (Join-Path $DcDir 'device-context-mode') -Force }
    foreach ($pair in @(@($Hist, 'tool-history.jsonl.original'), @($Jrnl, 'device-context-events.jsonl.original'), @($Dbg, 'device-context-debug.jsonl.original'), @($Cfg, 'config.json.original'))) {
      $backup = Join-Path $Out $pair[1]
      if (Test-Path $backup) { Copy-Item $backup $pair[0] -Force } elseif ($pair[1] -ne 'config.json.original') { Remove-Item $pair[0] -ErrorAction SilentlyContinue }
    }
  }
  Set-Location $env:TEMP
  $moved = $false
  for ($k = 0; $k -lt 5 -and -not $moved; $k++) {
    try { Move-Item (Join-Path $Work 'device-context') $KitHome -ErrorAction Stop; $moved = $true } catch { Start-Sleep 2 }
  }
  if ($moved) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
  else { Write-Host "Kit NOT moved back: it is in $Work\device-context (your history backup is in its results folder). Move it to $KitHome by hand." }
}
Write-Host "`nDone ($total runs). Results: $KitHome\eval\results\$Stamp\summary.md"
