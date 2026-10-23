# Run in a child scope: Invoke-Expression must not close or reconfigure the caller's shell.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($env:OS -ne 'Windows_NT') {
        throw 'Use remote-macos.sh on macOS or remote-linux.sh on Linux.'
    }

    $originalPath = $env:PATH
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    $tempDir = $null
    try {
        if (-not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
            $installDir = Join-Path $env:LOCALAPPDATA 'DesktopCommander\node'
            if (-not (Test-Path -LiteralPath (Join-Path $installDir 'node.exe') -PathType Leaf)) {
                if (Test-Path -LiteralPath $installDir) {
                    throw "Incomplete Node.js installation at $installDir. Remove that directory and retry."
                }
                $architecture = $env:PROCESSOR_ARCHITECTURE
                if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
                switch ($architecture) {
                    'AMD64' { $arch = 'x64' }
                    'ARM64' { $arch = 'arm64' }
                    default { throw 'Automatic installation supports 64-bit Windows on x64 and ARM64.' }
                }

                [Net.ServicePointManager]::SecurityProtocol = $originalTls -bor [Net.SecurityProtocolType]::Tls12
                $installParent = Split-Path $installDir -Parent
                New-Item -ItemType Directory -Path $installParent -Force | Out-Null
                $tempDir = Join-Path $installParent ('.node-' + [Guid]::NewGuid().ToString('N'))
                New-Item -ItemType Directory -Path $tempDir | Out-Null

                $manifest = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
                # Node SHASUMS256.txt uses 256-bit SHA-256: 256 / 4 bits per hex digit = 64 characters.
                $entry = [regex]::Match($manifest, "(?m)^([a-f0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-$arch\.zip)\r?$")
                if (-not $entry.Success) { throw 'No matching Node.js download was found.' }
                $archive = $entry.Groups[2].Value
                $version = $entry.Groups[3].Value
                $archivePath = Join-Path $tempDir $archive
                Write-Host "Installing Node.js $version in $installDir"
                Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$version/$archive" -OutFile $archivePath
                if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $entry.Groups[1].Value) {
                    throw 'Node.js checksum verification failed.'
                }
                Expand-Archive -LiteralPath $archivePath -DestinationPath $tempDir
                $extracted = Join-Path $tempDir "node-$version-win-$arch"
                & (Join-Path $extracted 'node.exe') --version | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'This Node.js build cannot run on your OS. Install a supported Node.js version manually.' }
                Move-Item -LiteralPath $extracted -Destination $installDir
                Remove-Item -LiteralPath $tempDir -Recurse -Force
                $tempDir = $null
            }
            $env:PATH = "$installDir;$env:PATH"
        }

        # Package engines require Node >=22.12.0: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
        & node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
        if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.12+ is required. Upgrade your existing Node.js installation and rerun this command.' }
        if (-not (Get-Command npx.cmd -CommandType Application -ErrorAction SilentlyContinue)) {
            throw 'npx.cmd is missing. Install npm for your existing Node.js installation and retry.'
        }
        Write-Host "Starting Desktop Commander with Node.js $(& node.exe --version). Press Ctrl+C to stop; rerun this command to start again."
        & npx.cmd --yes '@wonderwhy-er/desktop-commander@latest' remote
        if ($LASTEXITCODE -ne 0) { throw "Desktop Commander exited with code $LASTEXITCODE." }
    }
    finally {
        $env:PATH = $originalPath
        [Net.ServicePointManager]::SecurityProtocol = $originalTls
        if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force
        }
    }
}
