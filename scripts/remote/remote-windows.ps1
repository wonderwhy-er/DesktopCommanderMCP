# Run in a child scope: Invoke-Expression must not close or reconfigure the caller's shell.
& {
    # Prepare: stop on errors, check the platform, and save settings to restore later.
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($env:OS -ne 'Windows_NT') {
        throw 'Use remote-macos.sh on macOS or remote-linux.sh on Linux.'
    }

    $originalPath = $env:PATH
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    $tempDir = $null

    try {
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
                    throw 'Automatic installation supports 64-bit Windows on x64 and ARM64.'
                }
            }

            # Download: enable TLS for older PowerShell and use a temporary directory.
            [Net.ServicePointManager]::SecurityProtocol = $originalTls -bor [Net.SecurityProtocolType]::Tls12
            $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('dc-node-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $tempDir | Out-Null

            # The manifest supplies the checksum, file name, and exact Node 24 version.
            $manifest = (
                Invoke-WebRequest -UseBasicParsing `
                    'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'
            ).Content
            $entry = [regex]::Match(
                $manifest,
                # Node SHASUMS256.txt uses 256-bit SHA-256: 256 / 4 bits per hex digit = 64 characters.
                "(?m)^([a-f0-9]{64})\s+(node-(v24\.\d+\.\d+)-$arch\.msi)\r?$"
            )
            if (-not $entry.Success) {
                throw 'No matching Node.js download was found.'
            }
            # Regex groups contain the checksum (1), full installer file name (2), and version (3).
            $package = $entry.Groups[2].Value
            $version = $entry.Groups[3].Value
            $packagePath = Join-Path $tempDir $package
            Invoke-WebRequest -UseBasicParsing `
                "https://nodejs.org/dist/$version/$package" `
                -OutFile $packagePath

            # Verify the downloaded bytes before asking Windows to install them.
            if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $entry.Groups[1].Value) {
                throw 'Node.js checksum verification failed.'
            }

            # Install: use the standard Node.js destination and wait for MSI to finish.
            Write-Host "Installing Node.js $version with the standard Windows installer. Approve its administrator prompt to continue."
            # Elevate only MSI; /norestart prevents reboots: https://learn.microsoft.com/windows/win32/msi/standard-installer-command-line-options
            $installer = Start-Process `
                -FilePath (Join-Path $env:WINDIR 'System32\msiexec.exe') `
                -ArgumentList "/i `"$packagePath`" /passive /norestart" `
                -Verb RunAs `
                -Wait `
                -PassThru

            # MSI success codes 1641 (reboot initiated) and 3010 (reboot required): https://learn.microsoft.com/windows/win32/msi/error-codes
            if ($installer.ExitCode -in @(1641, 3010)) {
                Write-Host 'Node.js was installed. Restart Windows, then run this command again to start Desktop Commander.'
                return
            }
            if ($installer.ExitCode -ne 0) {
                throw "Node.js installation failed with Windows Installer code $($installer.ExitCode)."
            }

            # Load the installer's PATH update so this same invocation can start Node.js.
            $env:PATH = @(
                $originalPath,
                [Environment]::GetEnvironmentVariable('Path', 'Machine'),
                [Environment]::GetEnvironmentVariable('Path', 'User')
            ) -join ';'
            if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
                throw 'Node.js was installed but is not on PATH. Open a new terminal and run this command again.'
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
            throw 'Node.js 22.12+ is required. Upgrade your existing Node.js installation and rerun this command.'
        }
        if (-not (Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue)) {
            throw 'npx.cmd is missing. Install npm for your existing Node.js installation and retry.'
        }

        # Start Desktop Commander in this shell, without elevating the device command.
        Write-Host "Starting Desktop Commander with Node.js $(& node.exe --version). Press Ctrl+C to stop; rerun this command to start again."
        & npx.cmd --yes '@wonderwhy-er/desktop-commander@latest' remote
        if ($LASTEXITCODE -ne 0) {
            throw "Desktop Commander exited with code $LASTEXITCODE."
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
