param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '../scripts/remote/remote-windows.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('dc-launcher-test-' + [Guid]::NewGuid().ToString('N'))
$savedPath = $env:PATH
$savedOs = $env:OS
$savedLocalAppData = $env:LOCALAPPDATA
$savedArchitecture = $env:PROCESSOR_ARCHITECTURE
$savedWowArchitecture = $env:PROCESSOR_ARCHITEW6432
$savedTls = [Net.ServicePointManager]::SecurityProtocol
$savedErrorPreference = $ErrorActionPreference
$script:downloads = 0
$script:calls = @()
$script:existingNode = $true
$script:missingNpx = $false
$script:version = '22.12.0'
$script:commandExit = 0
$script:badChecksum = $false
$script:downloadFailure = $false
$script:checks = 0

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}

# Stub only the network and device command; extraction uses the host's real Node binary.
function Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -eq 'node.exe') {
        if ($script:existingNode) { return @{ Source = $NodePath } }
    } elseif ($Name -eq 'npx.cmd') {
        if (-not $script:missingNpx) { return @{ Source = 'fixture-npx.cmd' } }
    } else { throw "Unexpected command lookup: $Name" }
}

function node.exe {
    if ($args[0] -eq '--version') { return "v$script:version" }
    $code = "Object.defineProperty(process.versions, 'node', {value: '$script:version'}); " + $args[1]
    & $NodePath -e $code
    $global:LASTEXITCODE = $LASTEXITCODE
}

function npx.cmd {
    $script:calls += ($args -join ' ')
    $global:LASTEXITCODE = $script:commandExit
}

function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [Parameter(Position = 0)]$Uri, $OutFile)
    Assert $UseBasicParsing 'PowerShell downloads must use basic parsing.'
    $script:downloads++
    if ($script:downloadFailure) { throw 'Fixture network failure' }
    if ($Uri -eq 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') {
        $hash = (Get-FileHash -LiteralPath (Join-Path $temp 'fixture.zip') -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($script:badChecksum) { $hash = '0' * 64 }
        return @{ Content = "$hash  node-v22.23.4-win-x64.zip`n$hash  node-v22.23.4-win-arm64.zip`n$hash  node-v24.0.0-win-x64.zip`n$hash  node-v24.0.0-win-arm64.zip`n" }
    }
    Assert ($Uri -match '^https://nodejs.org/dist/v24\.0\.0/node-v24\.0\.0-win-(x64|arm64)\.zip$') 'Unexpected download URL.'
    Copy-Item -LiteralPath (Join-Path $temp 'fixture.zip') -Destination $OutFile
}

function Invoke-RestMethod {
    param($Uri, $ErrorAction)
    Assert ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) 'Bootstrap must enable TLS 1.2 before its first download.'
    Assert ($ErrorAction -eq 'Stop') 'Bootstrap download failures must stop execution.'
    Assert ($Uri -eq 'https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-windows.ps1') 'Bootstrap must use the public launcher source.'
    Get-Content -Raw -LiteralPath $launcher
}

function Expand-Archive {
    param($LiteralPath, $DestinationPath)
    $name = [IO.Path]::GetFileNameWithoutExtension($LiteralPath)
    $folder = Join-Path $DestinationPath $name
    New-Item -ItemType Directory -Path $folder | Out-Null
    if ($PSVersionTable.Platform -eq 'Unix') {
        New-Item -ItemType SymbolicLink -Path (Join-Path $folder 'node.exe') -Target $NodePath | Out-Null
    } else {
        Copy-Item -LiteralPath $NodePath -Destination (Join-Path $folder 'node.exe')
    }
}

function Run-Launcher([string]$ExpectedError = '') {
    $message = ''
    try {
        # Exercise the documented Invoke-Expression path, including its child scope.
        Invoke-Expression (Get-Content -Raw -LiteralPath $launcher)
    } catch { $message = $_.Exception.Message }
    if ($ExpectedError) { Assert ($message -like "*$ExpectedError*") "Expected '$ExpectedError'; got '$message'." }
    else { Assert (-not $message) "Unexpected launcher failure: $message" }
    Assert ($env:PATH -eq $savedPath) 'Launcher must restore the caller PATH.'
    Assert ([Net.ServicePointManager]::SecurityProtocol -eq $savedTls) 'Launcher must restore TLS settings.'
    Assert ($ErrorActionPreference -eq $savedErrorPreference) 'Launcher must preserve caller error preferences.'
}

try {
    New-Item -ItemType Directory -Path $temp | Out-Null
    Set-Content -LiteralPath (Join-Path $temp 'fixture.zip') -Value 'fixture archive'
    $env:OS = 'Windows_NT'
    $env:LOCALAPPDATA = Join-Path $temp 'user data'
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = ''
    Run-Launcher
    Assert ($script:downloads -eq 0) 'Existing Node must not trigger downloads.'
    Assert ($script:calls[0] -eq '--yes @wonderwhy-er/desktop-commander@latest remote') 'Wrong remote command.'
    $wrapper = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../scripts/remote/remote-windows.cmd')
    $bootstrap = [regex]::Match($wrapper, 'powershell\.exe -NoProfile -Command "([^"]+)"')
    Assert $bootstrap.Success 'CMD wrapper must invoke a child PowerShell.'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::SystemDefault
    Invoke-Expression $bootstrap.Groups[1].Value
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    foreach ($v in @('20.19.0', '22.11.0')) {
        $script:version = $v
        Run-Launcher '22.12+ is required'
    }
    foreach ($v in @('22.12.0', '24.0.0')) {
        $script:version = $v
        Run-Launcher
    }
    $script:missingNpx = $true
    Run-Launcher 'npx.cmd is missing'
    $script:missingNpx = $false
    $script:commandExit = 7
    Run-Launcher 'exited with code 7'
    $script:commandExit = 0
    $script:existingNode = $false
    $installed = Join-Path $env:LOCALAPPDATA 'DesktopCommander/node'
    foreach ($arch in @('AMD64', 'ARM64')) {
        $env:PROCESSOR_ARCHITECTURE = $arch
        Run-Launcher
        Assert (Test-Path -LiteralPath (Join-Path $installed 'node.exe')) 'Node must be installed.'
        $downloadsBeforeRepeat = $script:downloads
        Run-Launcher
        Assert ($script:downloads -eq $downloadsBeforeRepeat) 'Repeat runs must reuse private Node.'
        Remove-Item -LiteralPath $installed -Recurse -Force
    }
    $script:badChecksum = $true
    $callsBeforeFailure = $script:calls.Count
    Run-Launcher 'checksum verification failed'
    Assert (-not (Test-Path -LiteralPath $installed)) 'Corrupt downloads must not be installed.'
    Assert ($script:calls.Count -eq $callsBeforeFailure) 'Failed installation must not launch remote.'
    $script:badChecksum = $false
    $script:downloadFailure = $true
    Run-Launcher 'Fixture network failure'
    $script:downloadFailure = $false
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    Run-Launcher 'supports 64-bit Windows'
    $env:PROCESSOR_ARCHITEW6432 = 'AMD64'
    Run-Launcher
    Assert (Test-Path -LiteralPath (Join-Path $installed 'node.exe')) '32-bit PowerShell must detect the 64-bit OS.'
    $env:OS = 'Linux'
    Run-Launcher 'Use remote-macos.sh'
    Write-Host "PASS Windows launcher: $script:checks checks (network, extraction, and device command stubbed)"
} finally {
    $env:PATH = $savedPath
    $env:OS = $savedOs
    $env:LOCALAPPDATA = $savedLocalAppData
    $env:PROCESSOR_ARCHITECTURE = $savedArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $savedWowArchitecture
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    Remove-Item -LiteralPath $temp -Recurse -Force
}
