# Run in a child scope: Invoke-Expression must not close or reconfigure the caller's shell.
& {
    # Prepare: stop on errors, check the platform, and save settings to restore later.
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($env:OS -ne 'Windows_NT') {
        throw 'Please use the macOS or Linux command for this computer.'
    }

    $originalPath = $env:PATH
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    $tempDir = $null

    try {
        # Choose the installer for Windows itself, even from a 32-bit PowerShell.
        $architecture = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) {
            $architecture = $env:PROCESSOR_ARCHITEW6432
        }
        switch ($architecture) {
            'AMD64' {
                $arch = 'x64'
            }
            'ARM64' {
                $arch = 'arm64'
            }
            default {
                $arch = $null
            }
        }
        if ($arch) {
            # Pin the manual link to https://nodejs.org/dist/v24.22.1/SHASUMS256.txt so guidance makes no network requests.
            $manualDownloadUrl = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-$arch.msi"
        }
        else {
            $manualDownloadUrl = 'https://nodejs.org/en/download'
        }

        # Find existing Node.js before downloading anything.
        if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
            # A previous installer may have updated PATH after this terminal was opened.
            # Keep this terminal's command priority when adding the persisted paths.
            $env:PATH = @(
                $originalPath,
                [Environment]::GetEnvironmentVariable('Path', 'Machine'),
                [Environment]::GetEnvironmentVariable('Path', 'User')
            ) -join ';'
        }

        if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
            # Confirm before downloading or installing anything; Enter chooses Yes, but missing input does not.
            Write-Host 'Remote Desktop Commander needs Node.js, which could not be found on this computer.'
            Write-Host
            Write-Host 'If you choose Yes, we will install Node.js 24, then download and start Remote Desktop Commander.'
            Write-Host
            try {
                $installConsent = Read-Host 'Would you like to continue? Type Yes or No (press Enter for Yes)'
            }
            catch {
                throw 'We could not read your answer. Please open PowerShell or Command Prompt and run this command again.'
            }
            Write-Host
            if ($null -eq $installConsent -or $installConsent -notin @('', 'y', 'yes')) {
                Write-Host 'Node.js could not be found. You can choose either option:'
                Write-Host
                if ($arch) {
                    Write-Host '1. To install Node.js yourself, use this download link:'
                    Write-Host
                    Write-Host $manualDownloadUrl
                    Write-Host
                    Write-Host 'Open the downloaded file to install Node.js. Then open a new window and run the command below.'
                }
                else {
                    Write-Host '1. Choose a Node.js download for your computer here:'
                    Write-Host
                    Write-Host $manualDownloadUrl
                }
                Write-Host
                Write-Host '2. If Node.js is already installed, open a new PowerShell or Command Prompt window and run:'
                Write-Host
                Write-Host 'npx.cmd @wonderwhy-er/desktop-commander@latest remote'
                return
            }

            if (-not $arch) {
                throw "This computer cannot use the automatic Node.js installer. Please install Node.js from $manualDownloadUrl, then run this command again."
            }

            # Download: enable TLS for older PowerShell and use a temporary directory.
            [Net.ServicePointManager]::SecurityProtocol = $originalTls -bor [Net.SecurityProtocolType]::Tls12
            $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('dc-node-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempDir | Out-Null

            # The manifest supplies the checksum, file name, and exact Node 24 version.
            try {
                $manifest = (
                    Invoke-WebRequest -UseBasicParsing `
                        'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'
                ).Content
            }
            catch {
                throw 'We could not download Node.js. Check your internet connection and run this command again.'
            }
            $entry = [regex]::Match(
                $manifest,
                # Node SHASUMS256.txt uses 256-bit SHA-256: 256 / 4 bits per hex digit = 64 characters.
                "(?m)^([a-f0-9]{64})\s+(node-(v24\.\d+\.\d+)-$arch\.msi)\r?$"
            )
            if (-not $entry.Success) {
                throw "We could not find a Node.js installer for this computer. Please install Node.js from $manualDownloadUrl, then run this command again."
            }
            # Regex groups contain the checksum (1), full installer file name (2), and version (3).
            $package = $entry.Groups[2].Value
            $version = $entry.Groups[3].Value
            $packagePath = Join-Path $tempDir $package
            try {
                Invoke-WebRequest -UseBasicParsing `
                    "https://nodejs.org/dist/$version/$package" `
                    -OutFile $packagePath
            }
            catch {
                throw 'We could not download Node.js. Check your internet connection and run this command again.'
            }

            # Verify the downloaded bytes before asking Windows to install them.
            if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $entry.Groups[1].Value) {
                throw 'The Node.js download could not be verified. Please run this command again.'
            }

            # Install: use the standard Node.js destination and wait for MSI to finish.
            Write-Host 'Installing Node.js...'
            # Elevate only MSI; /norestart prevents reboots: https://learn.microsoft.com/windows/win32/msi/standard-installer-command-line-options
            try {
                $installer = Start-Process `
                    -FilePath (Join-Path $env:WINDIR 'System32\msiexec.exe') `
                    -ArgumentList "/i `"$packagePath`" /passive /norestart" `
                    -Verb RunAs `
                    -Wait `
                    -PassThru
            }
            catch {
                throw 'Node.js was not installed. Please run this command again and allow the installer to continue.'
            }

            # MSI success codes 1641 (reboot initiated) and 3010 (reboot required): https://learn.microsoft.com/windows/win32/msi/error-codes
            if ($installer.ExitCode -in @(1641, 3010)) {
                Write-Host 'Node.js is installed. Restart your computer, then run this command again.'
                return
            }
            if ($installer.ExitCode -ne 0) {
                throw "Node.js could not be installed. Please install it from $manualDownloadUrl, then run this command again."
            }

            # Load the installer's PATH update so this same invocation can start Node.js.
            $env:PATH = @(
                $originalPath,
                [Environment]::GetEnvironmentVariable('Path', 'Machine'),
                [Environment]::GetEnvironmentVariable('Path', 'User')
            ) -join ';'
            if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
                throw 'Node.js is installed. Please open a new PowerShell or Command Prompt window and run this command again.'
            }
        }

        # Validate: both existing and newly installed Node.js must meet the package requirement.
        & node.exe -e "
            const [major, minor] = process.versions.node.split('.').map(Number);
            process.exit(
                // Package engines require Node >=22.12.0: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
                major > 22 || (major === 22 && minor >= 12) ? 0 : 1
            );
        "
        if ($LASTEXITCODE -ne 0) {
            throw "Your Node.js version is too old. Please install a newer version from $manualDownloadUrl, then run this command again."
        }
        if (-not (Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue)) {
            throw "Your Node.js installation is incomplete. Please reinstall Node.js from $manualDownloadUrl, then run this command again."
        }

        # Start Desktop Commander in this shell, without elevating the device command.
        Write-Host 'Starting Remote Desktop Commander. To stop it, press Ctrl+C. To start it again, run this command again.'
        & npx.cmd --yes '@wonderwhy-er/desktop-commander@latest' remote
        if ($LASTEXITCODE -ne 0) {
            throw 'Remote Desktop Commander stopped unexpectedly. Please run this command again.'
        }
    }
    finally {
        # Restore the caller's settings and remove downloads, including after errors or Ctrl+C.
        $env:PATH = $originalPath
        [Net.ServicePointManager]::SecurityProtocol = $originalTls
        if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force
        }
    }
}
