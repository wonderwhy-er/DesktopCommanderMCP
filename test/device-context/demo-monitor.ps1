# Live view of what the model does through Desktop Commander. Run it in a second window next to Claude Desktop:
#   powershell -ExecutionPolicy Bypass -File C:\dev\DesktopCommanderMCP\test\device-context\demo-monitor.ps1
# Shows every DC tool call as it happens, marks calls that explore the disk, prints the device-context card
# when DC adds it (needs DESKTOP_COMMANDER_DEVICE_CONTEXT_DEBUG=1, which claude-desktop-setup.ps1 sets),
# and keeps a running tally. Keys: R = reset the tally for the next run, Q = quit.
# Reads only DC's own log files; changes nothing.
param([switch]$All)   # -All: also show calls marked origin 'ui' (diagnostics made from the DC UI, not by the model)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Dir  = Join-Path $env:USERPROFILE '.claude-server-commander'
$Hist = Join-Path $Dir 'tool-history.jsonl'
$Dbg  = Join-Path $Dir 'device-context-debug.jsonl'
$Mode = Join-Path $Dir 'device-context-mode'

# Tail a file from its current end; survives the file being rewritten or recreated
function New-Tail($path) { $len = 0; if (Test-Path $path) { $len = (Get-Item $path).Length }; @{ Path = $path; Pos = $len; Rest = '' } }
function Read-Lines($t) {
    if (-not (Test-Path $t.Path)) { return @() }
    $len = (Get-Item $t.Path).Length
    if ($len -lt $t.Pos) { $t.Pos = 0; $t.Rest = '' }
    if ($len -eq $t.Pos) { return @() }
    try {
        $fs = [System.IO.File]::Open($t.Path, 'Open', 'Read', 'ReadWrite,Delete')
        $fs.Seek($t.Pos, 'Begin') | Out-Null
        $buf = New-Object byte[] ($len - $t.Pos)
        $n = $fs.Read($buf, 0, $buf.Length); $fs.Close()
    } catch { return @() }
    $t.Pos += $n
    $text = $t.Rest + [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
    $parts = $text -split "`n"
    $t.Rest = $parts[-1]
    return @($parts[0..($parts.Length - 2)] | Where-Object { $_.Trim() })
}

$ExploreTools = @('list_directory', 'start_search', 'get_more_search_results')
$ExploreCmd   = '^\s*(ls|dir|Get-ChildItem|gci|find|where|where\.exe|pwd|whoami|tree|Get-Location)\b'
function Key-Arg($r) {
    $a = $r.arguments
    if (-not $a) { return '' }
    foreach ($k in 'path', 'file_path', 'command', 'pattern', 'project') { if ($a.$k) { $v = [string]$a.$k; if ($v.Length -gt 70) { $v = $v.Substring(0, 67) + '...' }; return $v } }
    if ($a.paths) { return ($a.paths -join ', ') }
    return ''
}
function Outcome($r) {
    $o = if ($r.output -is [string]) { $r.output } else { (@($r.output.content) | ForEach-Object { $_.text }) -join "`n" }
    if ($r.status -eq 'error' -or $o -match '^\s*Error') { return 'error' }
    if ($o -match 'exit code (-?\d+)' -and $Matches[1] -notin '0', '130', '143') { return 'failed' }
    return 'ok'
}

$tally = @{ calls = 0; explore = 0; first = ''; card = $false }
function Show-Tally {
    $c = if ($tally.card) { 'yes' } else { 'no' }
    Write-Host ("      calls {0} | exploring the disk {1} | first call {2} | card shown {3}" -f $tally.calls, $tally.explore, $tally.first, $c) -ForegroundColor DarkGray
}
function Header {
    $m = if (Test-Path $Mode) { (Get-Content $Mode -Raw).Trim() } else { 'env' }
    Write-Host ''
    Write-Host "Desktop Commander live view | device context mode: $m | R = new run, Q = quit" -ForegroundColor Cyan
    Write-Host ('-' * 78) -ForegroundColor DarkGray
}

$h = New-Tail $Hist; $d = New-Tail $Dbg
Header
while ($true) {
    foreach ($line in (Read-Lines $h)) {
        try { $r = $line | ConvertFrom-Json } catch { continue }
        if (-not $All -and $r.arguments.origin -eq 'ui') { continue }
        $tool = [string]$r.toolName
        $arg = Key-Arg $r
        $exp = ($ExploreTools -contains $tool) -or ($tool -eq 'start_process' -and [string]$r.arguments.command -match $ExploreCmd)
        $tally.calls++; if ($exp) { $tally.explore++ }; if (-not $tally.first) { $tally.first = $tool }
        $when = try { ([datetime]$r.timestamp).ToLocalTime().ToString('HH:mm:ss') } catch { '--:--:--' }
        $out = Outcome $r
        $color = if ($tool -eq 'get_device_context') { 'Green' } elseif ($exp) { 'Yellow' } elseif ($out -ne 'ok') { 'Red' } else { 'White' }
        $tag = if ($exp) { '  [exploring]' } else { '' }
        Write-Host ("{0}  {1,-22} {2}  -> {3}{4}" -f $when, $tool, $arg, $out, $tag) -ForegroundColor $color
        if ($tool -eq 'get_device_context') { $tally.card = $true }
        Show-Tally
    }
    foreach ($line in (Read-Lines $d)) {
        try { $e = $line | ConvertFrom-Json } catch { continue }
        $text = $null
        if ($e.event -eq 'decision' -and $e.appended) { $text = [string]$e.text; $why = "added to $($e.tool): $($e.reason)" }
        elseif ($e.event -eq 'tool') { $text = [string]$e.text; $why = 'returned by get_device_context' }
        if (-not $text) { continue }
        $tally.card = $true
        Write-Host ("      device-context card ({0} chars, {1})" -f $text.Length, $why) -ForegroundColor Green
        foreach ($l in ($text -split "`n" | Select-Object -First 8)) {
            if ($l.Length -gt 110) { $l = $l.Substring(0, 107) + '...' }
            Write-Host "        $l" -ForegroundColor DarkGreen
        }
    }
    $k = $null
    try { if ([Console]::KeyAvailable) { $k = [Console]::ReadKey($true).Key } } catch { }   # no keyboard when output is redirected
    if ($k -eq 'Q') { break }
    if ($k -eq 'R') { $tally = @{ calls = 0; explore = 0; first = ''; card = $false }; Header }
    Start-Sleep -Milliseconds 400
}
