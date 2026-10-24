param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot '../scripts/remote/remote-windows.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('dc-launcher-test-' + [Guid]::NewGuid().ToString('N'))
$savedPath = $env:PATH
$savedOs = $env:OS
$savedWindir = $env:WINDIR
$savedArchitecture = $env:PROCESSOR_ARCHITECTURE
$savedWowArchitecture = $env:PROCESSOR_ARCHITEW6432
$savedTls = [Net.ServicePointManager]::SecurityProtocol
$savedErrorPreference = $ErrorActionPreference
$script:downloads = 0
$script:calls = @()
$script:existingNode = $true
$script:systemNode = $false
$script:missingNpx = $false
$script:version = '22.12.0'
$script:commandExit = 0
$script:badChecksum = $false
$script:downloadFailure = $false
$script:installerExit = 0
$script:installerFailure = $false
$script:missingInstalledNode = $false
$script:installations = 0
$script:downloadPaths = @()
$script:consentAnswer = 'yes'
$script:promptFailure = $false
$script:prompts = 0
$script:createdDirectories = 0
$script:hostMessages = @()
$refreshedPath = @($savedPath, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
$script:checks = 0

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}

# Stub network, MSI execution, and device commands; never install software on the test host.
function Write-Host {
    param($Object)
    $script:hostMessages += [string]$Object
    Microsoft.PowerShell.Utility\Write-Host $Object
}

function Read-Host {
    param($Prompt)
    $script:prompts++
    Assert ($script:hostMessages[-4] -eq 'Remote Desktop Commander needs Node.js, which could not be found on this computer.') 'Explain why Node.js is needed without assuming it is not installed.'
    Assert ($script:hostMessages[-3] -eq '') 'Separate the Node.js explanation from the Yes explanation with a blank line.'
    Assert ($script:hostMessages[-2] -eq 'If you choose Yes, we will install Node.js 24, then download and start Remote Desktop Commander.') 'Explain both installation and device startup before asking for consent.'
    Assert ($script:hostMessages[-1] -eq '') 'Separate the Yes explanation from the prompt with a blank line.'
    Assert ($Prompt -eq 'Would you like to continue? Type Yes or No (press Enter for Yes)') 'Consent must offer Yes/No with Yes as the Enter default.'
    if ($script:promptFailure) { throw 'Fixture prompt unavailable' }
    # Read-Host at EOF produces no pipeline value, which differs from an explicit null result.
    if ($null -eq $script:consentAnswer) { return }
    return $script:consentAnswer
}

function New-Item {
    param($ItemType, $Path)
    $script:createdDirectories++
    Microsoft.PowerShell.Management\New-Item -ItemType $ItemType -Path $Path
}

function Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -eq 'node.exe') {
        if ($script:existingNode -or ($script:systemNode -and $env:PATH -eq $refreshedPath)) { return @{ Source = $NodePath } }
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
    if (-not $script:existingNode) { Assert ($env:PATH -eq $refreshedPath) 'Remote must retain original PATH priority and include persisted Machine/User PATH.' }
    $script:calls += ($args -join ' ')
    $global:LASTEXITCODE = $script:commandExit
}

function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [Parameter(Position = 0)]$Uri, $OutFile)
    Assert $UseBasicParsing 'PowerShell downloads must use basic parsing.'
    $script:downloads++
    if ($script:downloadFailure) { throw 'Fixture network failure' }
    if ($Uri -eq 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') {
        $hash = (Get-FileHash -LiteralPath (Join-Path $temp 'fixture.msi') -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($script:badChecksum) { $hash = '0' * 64 }
        return @{ Content = "$hash  node-v22.23.4-x64.msi`n$hash  node-v22.23.4-arm64.msi`n$hash  node-v24.0.0-x64.msi`n$hash  node-v24.0.0-arm64.msi`n" }
    }
    Assert ($Uri -match '^https://nodejs.org/dist/v24\.0\.0/node-v24\.0\.0-(x64|arm64)\.msi$') 'Unexpected download URL.'
    $script:downloadPaths += $OutFile
    Copy-Item -LiteralPath (Join-Path $temp 'fixture.msi') -Destination $OutFile
}

function Invoke-RestMethod {
    param($Uri, $ErrorAction)
    Assert ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) 'Bootstrap must enable TLS 1.2 before its first download.'
    Assert ($ErrorAction -eq 'Stop') 'Bootstrap download failures must stop execution.'
    Assert ($Uri -eq 'https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/refs/heads/main/scripts/remote/remote-windows.ps1') 'Bootstrap must use the public launcher source.'
    Get-Content -Raw -LiteralPath $launcher
}

function Start-Process {
    param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
    Assert ($FilePath -eq (Join-Path $env:WINDIR 'System32\msiexec.exe')) 'Only the Windows installer may be launched in an elevated process.'
    Assert ($Verb -eq 'RunAs') 'MSI must request elevation.'
    Assert ($Wait -and $PassThru) 'Launcher must wait for and inspect the installer result.'
    $packagePath = $script:downloadPaths[-1]
    Assert ($ArgumentList -eq "/i `"$packagePath`" /passive /norestart") 'Use the quoted verified package, default install directory, and suppress restarts.'
    Assert ((Get-FileHash -LiteralPath $packagePath).Hash -eq (Get-FileHash -LiteralPath (Join-Path $temp 'fixture.msi')).Hash) 'Installer package must match the verified download.'
    $script:installations++
    if ($script:installerFailure) { throw 'Fixture UAC cancellation' }
    # MSI success codes: 0 complete, 1641 reboot initiated, 3010 reboot required; https://learn.microsoft.com/windows/win32/msi/error-codes
    $script:systemNode = ($script:installerExit -in @(0, 1641, 3010)) -and -not $script:missingInstalledNode
    return @{ ExitCode = $script:installerExit }
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
    foreach ($packagePath in $script:downloadPaths) {
        Assert (-not (Test-Path -LiteralPath (Split-Path $packagePath -Parent))) 'Downloaded installer directory must be cleaned up.'
    }
    $script:downloadPaths = @()
}

try {
    New-Item -ItemType Directory -Path $temp | Out-Null
    Set-Content -LiteralPath (Join-Path $temp 'fixture.msi') -Value 'fixture installer'
    $env:OS = 'Windows_NT'
    $env:WINDIR = Join-Path $temp 'Windows'
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = ''
    Run-Launcher
    Assert ($script:downloads -eq 0) 'Existing Node must not trigger downloads.'
    Assert ($script:installations -eq 0) 'Existing Node must not trigger an installer.'
    Assert ($script:prompts -eq 0) 'Existing Node must not trigger a consent prompt.'
    Assert ($script:calls[0] -eq '--yes @wonderwhy-er/desktop-commander@latest remote') 'Wrong remote command.'
    $wrapper = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../scripts/remote/remote-windows.cmd')
    $bootstrap = [regex]::Match($wrapper, 'powershell\.exe -NoProfile -Command "([^"]+)"')
    Assert $bootstrap.Success 'CMD wrapper must invoke a child PowerShell.'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::SystemDefault
    Invoke-Expression $bootstrap.Groups[1].Value
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    foreach ($v in @('20.19.0', '22.11.0')) {
        $script:version = $v
        Run-Launcher 'Your Node.js version is too old'
    }
    foreach ($v in @('22.12.0', '24.0.0')) {
        $script:version = $v
        Run-Launcher
    }
    $script:missingNpx = $true
    Run-Launcher 'Your Node.js installation is incomplete'
    $script:missingNpx = $false
    $script:commandExit = 7
    Run-Launcher 'Remote Desktop Commander stopped unexpectedly'
    $script:commandExit = 0
    $script:existingNode = $false
    $script:systemNode = $true
    Run-Launcher
    Assert ($script:downloads -eq 0) 'A standard installation on persisted PATH must be reused without downloads.'
    Assert ($script:installations -eq 0) 'A standard installation on persisted PATH must not be reinstalled.'
    Assert ($script:prompts -eq 0) 'Node on persisted PATH must not trigger a consent prompt.'

    $script:systemNode = $false
    $downloadsBeforeConsent = $script:downloads
    $installationsBeforeConsent = $script:installations
    $callsBeforeConsent = $script:calls.Count
    $directoriesBeforeConsent = $script:createdDirectories
    $expectedDeclineMessages = @(
        '',
        'Node.js could not be found. You can choose either option:',
        '',
        '1. To install Node.js yourself, use this download link:',
        '',
        # The offline manual link is pinned to the release in https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
        'https://nodejs.org/dist/v24.22.1/node-v24.22.1-x64.msi',
        '',
        'Open the downloaded file to install Node.js. Then open a new window and run the command below.',
        '',
        '2. If Node.js is already installed, open a new PowerShell or Command Prompt window and run:',
        '',
        'npx.cmd @wonderwhy-er/desktop-commander@latest remote'
    )
    # Null models end-of-input; No, invalid text, and missing input must cancel.
    foreach ($answer in @('n', 'no', 'No', 'maybe', 'yes ', $null)) {
        $script:consentAnswer = $answer
        $promptsBeforeRun = $script:prompts
        Run-Launcher
        Assert ($script:prompts -eq $promptsBeforeRun + 1) 'Missing Node must prompt exactly once.'
        $actualDeclineMessages = $script:hostMessages[(-$expectedDeclineMessages.Count)..-1]
        Assert (($actualDeclineMessages -join "`n") -eq ($expectedDeclineMessages -join "`n")) 'Declined or absent consent must preserve both options, URL, exact command, and blank lines between them.'
        Assert ($script:downloads -eq $downloadsBeforeConsent) 'Cancellation must not download anything.'
        Assert ($script:installations -eq $installationsBeforeConsent) 'Cancellation must not install anything.'
        Assert ($script:calls.Count -eq $callsBeforeConsent) 'Cancellation must not start remote.'
        Assert ($script:createdDirectories -eq $directoriesBeforeConsent) 'Cancellation must not create a temporary directory.'
    }
    $script:promptFailure = $true
    Run-Launcher 'We could not read your answer'
    Assert ($script:downloads -eq $downloadsBeforeConsent) 'An unavailable prompt must not download anything.'
    Assert ($script:installations -eq $installationsBeforeConsent) 'An unavailable prompt must not install anything.'
    Assert ($script:calls.Count -eq $callsBeforeConsent) 'An unavailable prompt must not start remote.'
    Assert ($script:createdDirectories -eq $directoriesBeforeConsent) 'An unavailable prompt must not create a temporary directory.'
    $script:promptFailure = $false

    $script:consentAnswer = 'no'
    $promptsBeforeWrapper = $script:prompts
    Invoke-Expression $bootstrap.Groups[1].Value
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    Assert ($script:prompts -eq $promptsBeforeWrapper + 1) 'CMD must delegate exactly one confirmation to the PowerShell launcher.'
    $actualDeclineMessages = $script:hostMessages[(-$expectedDeclineMessages.Count)..-1]
    Assert (($actualDeclineMessages -join "`n") -eq ($expectedDeclineMessages -join "`n")) 'Declining from CMD must preserve both options, URL, exact command, and blank lines between them.'
    Assert ($script:downloads -eq $downloadsBeforeConsent) 'Declining from CMD must not download Node.js.'
    Assert ($script:installations -eq $installationsBeforeConsent) 'Declining from CMD must not install Node.js.'
    Assert ($script:calls.Count -eq $callsBeforeConsent) 'Declining from CMD must not start remote.'
    Assert ($script:createdDirectories -eq $directoriesBeforeConsent) 'Declining from CMD must not create a temporary directory.'

    foreach ($platform in @(
        @{ Process = 'AMD64'; Native = ''; Download = 'x64' },
        @{ Process = 'ARM64'; Native = ''; Download = 'arm64' },
        @{ Process = 'x86'; Native = 'AMD64'; Download = 'x64' },
        @{ Process = 'x86'; Native = 'ARM64'; Download = 'arm64' },
        @{ Process = 'unknown'; Native = ''; Download = $null }
    )) {
        $env:PROCESSOR_ARCHITECTURE = $platform.Process
        $env:PROCESSOR_ARCHITEW6432 = $platform.Native
        $messagesBeforeRun = $script:hostMessages.Count
        Run-Launcher
        $guidance = $script:hostMessages[$messagesBeforeRun..($script:hostMessages.Count - 1)]
        Assert ($guidance -contains 'npx.cmd @wonderwhy-er/desktop-commander@latest remote') 'Every Windows architecture must retain the manual command.'
        Assert ($guidance[7] -like '1. *' -and $guidance[-3] -like '2. *') 'Option 1 must appear before option 2 on every Windows architecture.'
        if ($platform.Download) {
            # The offline manual link is pinned to the release in https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
            $expectedDownload = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-$($platform.Download).msi"
            Assert ($script:hostMessages[-7] -eq $expectedDownload) 'The direct link must match the native Windows architecture.'
            Assert ($script:hostMessages[-8] -eq '' -and $script:hostMessages[-6] -eq '') 'Separate the direct installer URL from surrounding text with blank lines.'
        }
        else {
            $expectedDownload = 'https://nodejs.org/en/download'
            $expectedFallbackMessages = @(
                '',
                'Node.js could not be found. You can choose either option:',
                '',
                '1. Choose a Node.js download for your computer here:',
                '',
                $expectedDownload,
                '',
                '2. If Node.js is already installed, open a new PowerShell or Command Prompt window and run:',
                '',
                'npx.cmd @wonderwhy-er/desktop-commander@latest remote'
            )
            $actualFallbackMessages = $script:hostMessages[(-$expectedFallbackMessages.Count)..-1]
            Assert (($actualFallbackMessages -join "`n") -eq ($expectedFallbackMessages -join "`n")) 'Unknown architectures must preserve fallback guidance, the official URL, command, and blank lines.'
            Assert (-not ($guidance -match '^https://nodejs.org/dist/')) 'Unknown architectures must not default to an x64 download.'
        }

        # Existing installations need the same native download link, without prompting or installing.
        $promptsBeforeErrors = $script:prompts
        $script:existingNode = $true
        $script:version = '22.11.0'
        Run-Launcher "Your Node.js version is too old. Please install a newer version from $expectedDownload, then run this command again."
        $script:version = '24.0.0'
        $script:missingNpx = $true
        Run-Launcher "Your Node.js installation is incomplete. Please reinstall Node.js from $expectedDownload, then run this command again."
        $script:missingNpx = $false
        $script:existingNode = $false
        Assert ($script:prompts -eq $promptsBeforeErrors) 'Old or incomplete existing Node must not prompt for installation.'
        Assert ($script:downloads -eq $downloadsBeforeConsent) 'Manual download guidance must not download anything.'
        Assert ($script:installations -eq $installationsBeforeConsent) 'Manual download guidance must not install anything.'
        Assert ($script:calls.Count -eq $callsBeforeConsent) 'Manual download guidance must not start remote.'
        Assert ($script:createdDirectories -eq $directoriesBeforeConsent) 'Manual download guidance must not create a temporary directory.'
    }
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $env:PROCESSOR_ARCHITEW6432 = ''

    foreach ($answer in @('', 'y', 'Y', 'yes', 'YeS')) {
        $script:consentAnswer = $answer
        $script:systemNode = $false
        $promptsBeforeRun = $script:prompts
        $installationsBeforeRun = $script:installations
        $callsBeforeRun = $script:calls.Count
        Run-Launcher
        Assert ($script:prompts -eq $promptsBeforeRun + 1) 'Accepted consent must prompt exactly once.'
        Assert ($script:installations -eq $installationsBeforeRun + 1) 'Pressing Enter or entering y/yes must install Node.'
        Assert ($script:calls.Count -eq $callsBeforeRun + 1) 'Successful installation after consent must start remote.'
    }

    foreach ($arch in @('AMD64', 'ARM64')) {
        $script:systemNode = $false
        $env:PROCESSOR_ARCHITECTURE = $arch
        $installationsBeforeRun = $script:installations
        Run-Launcher
        Assert ($script:installations -eq $installationsBeforeRun + 1) 'Node MSI must run once.'
        $downloadsBeforeRepeat = $script:downloads
        $promptsBeforeRepeat = $script:prompts
        Run-Launcher
        Assert ($script:downloads -eq $downloadsBeforeRepeat) 'Repeat runs must reuse standard Node from persisted PATH.'
        Assert ($script:installations -eq $installationsBeforeRun + 1) 'Repeat runs must not reinstall Node.'
        Assert ($script:prompts -eq $promptsBeforeRepeat) 'Repeat runs must not ask for installation consent again.'
    }
    $script:systemNode = $false
    $script:badChecksum = $true
    $callsBeforeFailure = $script:calls.Count
    $installationsBeforeFailure = $script:installations
    Run-Launcher 'The Node.js download could not be verified'
    Assert ($script:installations -eq $installationsBeforeFailure) 'Corrupt downloads must not be installed.'
    Assert ($script:calls.Count -eq $callsBeforeFailure) 'Failed installation must not launch remote.'
    $script:badChecksum = $false
    $script:downloadFailure = $true
    Run-Launcher 'We could not download Node.js'
    $script:downloadFailure = $false
    # MSI failures: 1602 canceled, 1603 fatal error, 1618 another install running; https://learn.microsoft.com/windows/win32/msi/error-codes
    foreach ($exitCode in @(1602, 1603, 1618)) {
        $script:installerExit = $exitCode
        Run-Launcher 'Node.js could not be installed'
        Assert ($script:calls.Count -eq $callsBeforeFailure) 'Failed MSI must not launch remote.'
    }
    $script:installerExit = 0
    $script:installerFailure = $true
    Run-Launcher 'Node.js was not installed'
    Assert ($script:calls.Count -eq $callsBeforeFailure) 'Canceled elevation must not launch remote.'
    $script:installerFailure = $false
    $script:missingInstalledNode = $true
    Run-Launcher 'Please open a new PowerShell or Command Prompt window'
    Assert ($script:calls.Count -eq $callsBeforeFailure) 'Missing installed Node must not launch remote.'
    $script:missingInstalledNode = $false
    # MSI success with reboot required (3010) or initiated (1641): https://learn.microsoft.com/windows/win32/msi/error-codes
    foreach ($exitCode in @(3010, 1641)) {
        $script:systemNode = $false
        $script:installerExit = $exitCode
        Run-Launcher
        Assert ($script:calls.Count -eq $callsBeforeFailure) 'Reboot-required MSI success must not launch remote before a restart.'
    }
    $script:installerExit = 0
    $script:systemNode = $false
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    Run-Launcher 'This computer cannot use the automatic Node.js installer'
    $env:PROCESSOR_ARCHITEW6432 = 'AMD64'
    Run-Launcher
    Assert $script:systemNode '32-bit PowerShell must detect and install for the 64-bit OS.'
    $env:OS = 'Linux'
    Run-Launcher 'Please use the macOS or Linux command'
    Write-Host "PASS Windows launcher: $script:checks checks (network, MSI installer, and device command stubbed)"
} finally {
    $env:PATH = $savedPath
    $env:OS = $savedOs
    $env:WINDIR = $savedWindir
    $env:PROCESSOR_ARCHITECTURE = $savedArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $savedWowArchitecture
    [Net.ServicePointManager]::SecurityProtocol = $savedTls
    Remove-Item -LiteralPath $temp -Recurse -Force
}
