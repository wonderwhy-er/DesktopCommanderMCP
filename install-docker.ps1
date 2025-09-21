#!/usr/bin/env powershell
param(
    [string]$Option = "",
    [switch]$Help,
    [switch]$Status,
    [switch]$Reset,
    [switch]$VerboseOutput
)

# Script-level variables for folder and Docker args
$script:Folders = @()
$script:DockerArgs = @()

# Colors and output functions
function Write-Success { param($Message) Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Warning { param($Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Blue }

function Write-Header {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Blue
    Write-Host "                         CLAUDE                                 " -ForegroundColor Blue  
    Write-Host "                   SERVER COMMANDER                             " -ForegroundColor Blue
    Write-Host "                    Docker Installer                           " -ForegroundColor Blue
    Write-Host "================================================================" -ForegroundColor Blue
    Write-Host ""
    Write-Info "Experiment with AI in secure sandbox environment that won't mess up your main computer"
    Write-Host ""
}

function Test-Docker {
    while ($true) {
        try {
            $null = Get-Command docker -ErrorAction Stop
        } catch {
            Write-Error "Docker is not installed or not found"
            Write-Host ""
            Write-Error "Please install Docker first:"
            Write-Error "Download Docker Desktop: https://www.docker.com/products/docker-desktop/"
            Write-Host ""
            $null = Read-Host "Press Enter when Docker Desktop is installed or Ctrl+C to exit"
            continue
        }

        Write-Info "Checking Docker installation and daemon status..."
        try {
            $null = docker info 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Success "Docker is installed and running"
                break
            } else {
                throw "Docker daemon not running"
            }
        } catch {
            Write-Error "Docker is installed but not running"
            Write-Host ""
            Write-Error "Please start Docker Desktop and try again"
            Write-Info "Make sure Docker Desktop is fully started (check system tray)"
            Write-Host ""
            $null = Read-Host "Press Enter when Docker Desktop is running or Ctrl+C to exit"
            continue
        }
    }
}

function Get-DockerImage {
    Write-Info "Pulling latest Docker image (this may take a moment)..."
    try {
        docker pull mcp/desktop-commander:latest
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Docker image ready: mcp/desktop-commander:latest"
        } else {
            Write-Error "Failed to pull Docker image"
            Write-Info "Check your internet connection and Docker Hub access"
            exit 1
        }
    } catch {
        Write-Error "Failed to get Docker image"
        Write-Info "This could be a network issue or Docker Hub being unavailable"
        exit 1
    }
}function Ask-ForFolders {
    Write-Host ""
    Write-Host "Folder Access Setup" -ForegroundColor Blue
    Write-Info "By default, Desktop Commander will have access to your user folder:"
    Write-Info "Folder: $env:USERPROFILE"
    Write-Host ""
    $response = Read-Host "Press Enter to accept user folder access or 'y' to customize"
    
    $script:Folders = @()
    
    if ($response -match "^[Yy]$") {
        Write-Host ""
        Write-Info "Custom folder selection:"
        $homeResponse = Read-Host "Mount your complete home directory ($env:USERPROFILE)? [Y/n]"
        
        switch ($homeResponse.ToLower()) {
            { $_ -in @("n", "no") } { 
                Write-Info "Skipping home directory"
            }
            default { 
                $script:Folders += $env:USERPROFILE
                Write-Success "Added home directory access"
            }
        }

        Write-Host ""
        Write-Info "Add extra folders outside home directory (optional):"
        
        while ($true) {
            $customDir = Read-Host "Enter folder path (or Enter to finish)"
            
            if ([string]::IsNullOrEmpty($customDir)) {
                break
            }
            
            $customDir = [System.Environment]::ExpandEnvironmentVariables($customDir)
            $customDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($customDir)
            
            if (Test-Path $customDir -PathType Container) {
                $script:Folders += $customDir
                Write-Success "Added: $customDir"
            } else {
                $addAnyway = Read-Host "Folder doesn't exist. Add anyway? [y/N]"
                if ($addAnyway -match "^[Yy]$") {
                    $script:Folders += $customDir
                    Write-Info "Added: $customDir (will create if needed)"
                }
            }
        }

        if ($script:Folders.Count -eq 0) {
            Write-Host ""
            Write-Warning "WARNING: No folders selected - Desktop Commander will have NO file access"
            Write-Host ""
            Write-Info "This means:"
            Write-Host "  - Desktop Commander cannot read or write any files on your computer"
            Write-Host "  - It cannot help with coding projects, file management, or document editing"
            Write-Host "  - It will only work for system commands and package installation"
            Write-Host "  - This makes Desktop Commander much less useful than intended"
            Write-Host ""
            Write-Info "You probably want to share at least some folder to work with files"
            Write-Info "Most users share their home directory: $env:USERPROFILE"
            Write-Host ""
            $confirm = Read-Host "Continue with NO file access? [y/N]"
            if ($confirm -notmatch "^[Yy]$") {
                Write-Info "Restarting folder selection..."
                Ask-ForFolders
                return
            }
            Write-Warning "Proceeding with no file access - Desktop Commander will be limited"
        }
    } else {
        $script:Folders += $env:USERPROFILE
        Write-Success "Using default access to your user folder"
    }
}

function Initialize-Volumes {
    Write-Info "Setting up persistent development environment"
    Write-Host ""
    Write-Info "Creating essential volumes for development persistence:"
    Write-Info "- dc-system: All system packages, binaries, libraries"
    Write-Info "- dc-home: User configs, dotfiles, SSH keys, git config"
    Write-Info "- dc-workspace: Development files and projects"
    Write-Info "- dc-packages: Package databases, caches, logs"
    Write-Host ""

    $volumes = @("dc-system", "dc-home", "dc-workspace", "dc-packages")
    $volumesCreated = 0

    foreach ($volume in $volumes) {
        try {
            $null = docker volume inspect $volume 2>$null
            if ($LASTEXITCODE -ne 0) {
                docker volume create $volume | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Created volume: $volume"
                    $volumesCreated++
                } else {
                    Write-Warning "Failed to create volume: $volume"
                }
            } else {
                Write-Info "Volume already exists: $volume"
            }
        } catch {
            Write-Warning "Could not manage volume: $volume"
        }
    }

    if ($volumesCreated -gt 0) {
        Write-Host ""
        Write-Success "Created $volumesCreated new volume(s)"
    }
    Write-Success "Persistent environment ready - your tools will survive restarts!"
}

function Build-DockerArgs {
    Write-Info "Building Docker configuration..."

    $script:DockerArgs = @("run", "-i", "--rm")

    $essentialVolumes = @(
        "dc-system:/usr",
        "dc-home:/root", 
        "dc-workspace:/workspace",
        "dc-packages:/var"
    )

    foreach ($volume in $essentialVolumes) {
        $script:DockerArgs += "-v"
        $script:DockerArgs += $volume
    }

    foreach ($folder in $script:Folders) {
        # Get the full path structure after drive letter for absolute mounting
        if ($folder -match '^([A-Za-z]):(.+)$') {
            $absolutePath = $matches[2].TrimStart('\').Replace('\', '/')
            $script:DockerArgs += "-v"
            $script:DockerArgs += "${folder}:/home/$absolutePath"
        } else {
            # Fallback for non-standard paths - use basename
            $folderName = Split-Path $folder -Leaf
            $script:DockerArgs += "-v"
            $script:DockerArgs += "${folder}:/home/${folderName}"
        }
    }

    $script:DockerArgs += "mcp/desktop-commander:latest"

    if ($VerboseOutput) {
        Write-Info "Docker configuration ready"
        Write-Info "Essential volumes: 4 volumes"
        Write-Info "Mounted folders: $($script:Folders.Count) folders" 
        Write-Info "Container mode: Auto-remove after each use (--rm)"
    }
}function Find-ClaudeProcess {
    Write-Info "Looking for Claude Desktop processes..."
    
    # Try different process name patterns for Claude
    $processNames = @("Claude", "claude", "Claude Desktop", "claude-desktop", "ClaudeDesktop")
    $foundProcesses = @()
    
    foreach ($processName in $processNames) {
        if ($VerboseOutput) { Write-Info "Checking for process pattern: $processName" }
        try {
            $processes = Get-Process -Name $processName -ErrorAction SilentlyContinue
            if ($processes) {
                foreach ($proc in $processes) {
                    $procPath = try { $proc.Path } catch { "Unknown" }
                    $procWindowTitle = try { $proc.MainWindowTitle } catch { "N/A" }
                    
                    $foundProcesses += @{
                        Name = $proc.ProcessName
                        Id = $proc.Id
                        Path = $procPath
                        WindowTitle = $procWindowTitle
                    }
                    if ($VerboseOutput) { Write-Info "Found: $($proc.ProcessName) (PID: $($proc.Id))" }
                }
            }
        } catch {
            if ($VerboseOutput) { Write-Info "No processes found for pattern: $processName" }
        }
    }
    
    # Also try WMI for more comprehensive search
    if ($VerboseOutput) { Write-Info "Searching with WMI for Claude-related processes..." }
    try {
        $wmiProcesses = Get-WmiObject Win32_Process | Where-Object { 
            $_.Name -like "*claude*" -or 
            $_.CommandLine -like "*claude*" -or
            $_.ExecutablePath -like "*claude*"
        }
        
        foreach ($proc in $wmiProcesses) {
            $foundProcesses += @{
                Name = $proc.Name
                Id = $proc.ProcessId
                Path = $proc.ExecutablePath
                CommandLine = $proc.CommandLine
            }
            if ($VerboseOutput) { Write-Info "WMI Found: $($proc.Name) (PID: $($proc.ProcessId))" }
        }
    } catch {
        if ($VerboseOutput) { Write-Info "WMI search failed or no additional processes found" }
    }
    
    return $foundProcesses
}

function Stop-ClaudeProcess {
    Write-Info "Attempting to stop Claude Desktop..."
    
    $processes = Find-ClaudeProcess
    
    if ($processes.Count -eq 0) {
        Write-Info "No Claude Desktop processes found running"
        return $true
    }
    
    Write-Info "Found $($processes.Count) Claude-related process(es)"
    foreach ($proc in $processes) {
        Write-Info "  - $($proc.Name) (PID: $($proc.Id))"
        if ($proc.Path -and $proc.Path -ne "Unknown" -and $VerboseOutput) {
            Write-Info "    Path: $($proc.Path)"
        }
    }
    
    $stoppedCount = 0
    
    # Method 1: Graceful shutdown using Stop-Process
    Write-Info "Attempting graceful shutdown..."
    foreach ($proc in $processes) {
        try {
            Stop-Process -Id $proc.Id -ErrorAction Stop
            Write-Success "Gracefully stopped: $($proc.Name) (PID: $($proc.Id))"
            $stoppedCount++
        } catch {
            Write-Warning "Could not gracefully stop: $($proc.Name) (PID: $($proc.Id)) - $($_.Exception.Message)"
        }
    }
    
    # Wait a moment for graceful shutdown
    Start-Sleep -Seconds 2
    
    # Method 2: Force kill remaining processes
    $remainingProcesses = Find-ClaudeProcess
    if ($remainingProcesses.Count -gt 0) {
        Write-Info "Force stopping remaining processes..."
        foreach ($proc in $remainingProcesses) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                Write-Success "Force stopped: $($proc.Name) (PID: $($proc.Id))"
                $stoppedCount++
            } catch {
                Write-Error "Could not force stop: $($proc.Name) (PID: $($proc.Id)) - $($_.Exception.Message)"
            }
        }
    }
    
    # Final verification
    Start-Sleep -Seconds 1
    $finalProcesses = Find-ClaudeProcess
    if ($finalProcesses.Count -eq 0) {
        Write-Success "All Claude processes stopped successfully"
        return $true
    } else {
        Write-Warning "Some Claude processes may still be running"
        return $false
    }
}

function Find-ClaudeExecutable {
    if ($VerboseOutput) { Write-Info "Searching for Claude Desktop executable..." }
    
    # Common installation paths for Claude Desktop
    $claudePaths = @(
        "$env:LOCALAPPDATA\Programs\Claude\Claude.exe",
        "$env:PROGRAMFILES\Claude\Claude.exe", 
        "$env:PROGRAMFILES(x86)\Claude\Claude.exe",
        "$env:APPDATA\Claude\Claude.exe",
        "$env:USERPROFILE\AppData\Local\Programs\Claude\Claude.exe"
    )
    
    if ($VerboseOutput) { Write-Info "Checking standard installation paths..." }
    foreach ($path in $claudePaths) {
        if ($VerboseOutput) { Write-Info "Checking: $path" }
        if (Test-Path $path) {
            if ($VerboseOutput) { Write-Info "Found Claude executable: $path" }
            return $path
        }
    }
    
    # Check registry for installation location
    if ($VerboseOutput) { Write-Info "Searching Windows registry for Claude installation..." }
    try {
        $uninstallKeys = @(
            "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
        )
        
        foreach ($keyPath in $uninstallKeys) {
            try {
                $entries = Get-ItemProperty $keyPath -ErrorAction SilentlyContinue | Where-Object { 
                    $_.DisplayName -like "*Claude*" 
                }
                foreach ($entry in $entries) {
                    if ($entry.InstallLocation) {
                        $possibleExe = Join-Path $entry.InstallLocation "Claude.exe"
                        if ($VerboseOutput) { Write-Info "Registry found: $($entry.DisplayName) at $possibleExe" }
                        if (Test-Path $possibleExe) {
                            if ($VerboseOutput) { Write-Info "Found Claude executable via registry: $possibleExe" }
                            return $possibleExe
                        }
                    }
                    if ($entry.UninstallString) {
                        $uninstallDir = Split-Path $entry.UninstallString -Parent
                        $possibleExe = Join-Path $uninstallDir "Claude.exe"
                        if ($VerboseOutput) { Write-Info "Trying uninstall directory: $possibleExe" }
                        if (Test-Path $possibleExe) {
                            if ($VerboseOutput) { Write-Info "Found Claude executable via uninstall path: $possibleExe" }
                            return $possibleExe
                        }
                    }
                }
            } catch {
                if ($VerboseOutput) { Write-Info "Could not check registry key: $keyPath" }
            }
        }
    } catch {
        if ($VerboseOutput) { Write-Info "Registry search failed" }
    }
    
    # Last resort: search common program directories
    if ($VerboseOutput) { Write-Info "Performing broader search in program directories..." }
    $searchDirs = @(
        "$env:LOCALAPPDATA\Programs",
        "$env:PROGRAMFILES",
        "$env:PROGRAMFILES(x86)"
    )
    
    foreach ($dir in $searchDirs) {
        if (Test-Path $dir) {
            if ($VerboseOutput) { Write-Info "Searching in: $dir" }
            try {
                $found = Get-ChildItem -Path $dir -Recurse -Name "Claude.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($found) {
                    $fullPath = Join-Path $dir $found
                    if ($VerboseOutput) { Write-Info "Found Claude executable via search: $fullPath" }
                    return $fullPath
                }
            } catch {
                if ($VerboseOutput) { Write-Info "Could not search in: $dir" }
            }
        }
    }
    
    return $null
}

function Start-ClaudeProcess {
    Write-Info "Attempting to start Claude Desktop..."
    
    $claudePath = Find-ClaudeExecutable
    
    if (-not $claudePath) {
        Write-Warning "Could not find Claude Desktop executable"
        Write-Info "Claude may not be installed or may be in a non-standard location"
        Write-Info "You can start Claude Desktop manually after installation completes"
        return $false
    }
    
    Write-Success "Found Claude executable: $claudePath"
    
    try {
        Write-Info "Starting Claude Desktop..."
        if ($VerboseOutput) { Write-Info "Executing: Start-Process -FilePath '$claudePath' -PassThru" }
        $process = Start-Process -FilePath $claudePath -PassThru -ErrorAction Stop
        
        if ($process) {
            Write-Success "Process started with PID: $($process.Id)"
            
            # Wait for the process to initialize
            Write-Info "Waiting 5 seconds for Claude to initialize..."
            Start-Sleep -Seconds 5
            
            # Check if the process is still running
            try {
                $runningProcess = Get-Process -Id $process.Id -ErrorAction Stop
                Write-Success "Claude Desktop is running and stable (PID: $($runningProcess.Id))"
                Write-Success "Process name: $($runningProcess.ProcessName)"
                if ($runningProcess.MainWindowTitle -and $VerboseOutput) {
                    Write-Info "Window title: $($runningProcess.MainWindowTitle)"
                }
                return $true
            } catch {
                Write-Warning "Process started but exited quickly (PID: $($process.Id))"
                Write-Info "This might indicate a configuration issue"
                return $false
            }
        } else {
            Write-Error "Failed to start process - Start-Process returned null"
            return $false
        }
    } catch {
        Write-Error "Exception starting Claude Desktop: $($_.Exception.Message)"
        if ($VerboseOutput) { Write-Info "Full exception: $($_.Exception)" }
        return $false
    }
}

function Restart-Claude {
    Write-Info "Attempting to restart Claude Desktop..."
    
    # Step 1: Stop Claude
    $stopSuccess = Stop-ClaudeProcess
    
    if (-not $stopSuccess) {
        Write-Warning "Failed to stop Claude completely, but continuing with startup attempt"
    }
    
    # Step 2: Start Claude
    $startSuccess = Start-ClaudeProcess
    
    # Step 3: Final verification
    Write-Info "Verifying Claude restart..."
    Start-Sleep -Seconds 2
    $finalProcesses = Find-ClaudeProcess
    
    if ($startSuccess -and $finalProcesses.Count -gt 0) {
        Write-Success "Claude Desktop restart: SUCCESSFUL"
        Write-Info "Claude Desktop is now running with updated configuration"
        return $true
    } else {
        Write-Warning "Claude Desktop restart: PARTIAL or FAILED"
        Write-Info "You may need to start Claude Desktop manually"
        Write-Info "The configuration has been updated and will work when Claude starts"
        return $false
    }
}

function Update-ClaudeConfig {
    Write-Info "Updating Claude Desktop configuration..."

    $configPath = "$env:APPDATA\Claude\claude_desktop_config.json"
    Write-Info "Config location: $configPath"

    # No backup needed - direct config update

    $configDir = Split-Path $configPath -Parent
    if (!(Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        Write-Info "Created config directory"
    }

    # Read existing config or create new
    $config = @{}
    if (Test-Path $configPath) {
        try {
            # Read as JSON object first, then convert to hashtable if needed
            $jsonContent = Get-Content $configPath -Raw | ConvertFrom-Json
            
            # Convert PSCustomObject to hashtable for easier manipulation
            $config = @{}
            foreach ($property in $jsonContent.PSObject.Properties) {
                if ($property.Name -eq "mcpServers" -and $property.Value) {
                    # Preserve existing MCP servers
                    $config.mcpServers = @{}
                    foreach ($serverProperty in $property.Value.PSObject.Properties) {
                        $serverConfig = @{
                            command = $serverProperty.Value.command
                        }
                        if ($serverProperty.Value.args) {
                            $serverConfig.args = @($serverProperty.Value.args)
                        }
                        if ($serverProperty.Value.env) {
                            $serverConfig.env = @{}
                            foreach ($envProperty in $serverProperty.Value.env.PSObject.Properties) {
                                $serverConfig.env[$envProperty.Name] = $envProperty.Value
                            }
                        }
                        $config.mcpServers[$serverProperty.Name] = $serverConfig
                    }
                    Write-Info "Preserved $($config.mcpServers.Count) existing MCP server(s)"
                } else {
                    $config[$property.Name] = $property.Value
                }
            }
        } catch {
            Write-Warning "Could not parse existing config, creating new one"
            Write-Warning "Error: $($_.Exception.Message)"
            $config = @{}
        }
    } else {
        Write-Info "Creating new Claude configuration"
    }

    # Ensure mcpServers section exists
    if (!$config.mcpServers) {
        $config.mcpServers = @{}
        Write-Info "Created new mcpServers section"
    }

    # Check if our server already exists
    if ($config.mcpServers.ContainsKey("desktop-commander")) {
        Write-Info "Updating existing Desktop Commander configuration"
    } else {
        Write-Info "Adding new Desktop Commander configuration"
    }

    # Convert PowerShell array to proper format for JSON
    $argsArray = @()
    foreach ($arg in $script:DockerArgs) {
        $argsArray += $arg
    }

    # Add/update our server configuration (this preserves all other servers)
    $config.mcpServers["desktop-commander"] = @{
        command = "docker"
        args = $argsArray
    }

    # Save configuration
    try {
        $jsonConfig = $config | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($configPath, $jsonConfig, [System.Text.UTF8Encoding]::new($false))
        Write-Success "Claude configuration updated successfully"
        Write-Info "Server 'desktop-commander' added to MCP servers"
        Write-Info "Total MCP servers configured: $($config.mcpServers.Count)"
        
        # List all configured servers
        if ($config.mcpServers.Count -gt 1) {
            Write-Host ""
            Write-Info "All configured MCP servers:"
            foreach ($serverName in $config.mcpServers.Keys) {
                if ($serverName -eq "desktop-commander") {
                    Write-Info "  * $serverName (Desktop Commander) - UPDATED"
                } else {
                    Write-Info "  * $serverName (preserved)"
                }
            }
        }
        
        # Show what folders are mounted for our server
        if ($script:Folders.Count -gt 0) {
            Write-Host ""
            Write-Info "Folders accessible to Desktop Commander:"
            foreach ($folder in $script:Folders) {
                $folderName = Split-Path $folder -Leaf
                Write-Info "  Folder: $folder"
                Write-Info "    -> /home/$folderName (home-style path)"
                
                # Show Windows-style path too
                $windowsPath = $folder.Replace('\', '/')
                if ($windowsPath -match '^([A-Za-z]):(.*)') {
                    $windowsStylePath = "/$($matches[1].ToLower())$($matches[2])"
                    Write-Info "    -> $windowsStylePath (windows-style path)"
                }
            }
        } else {
            Write-Warning "No folders mounted - limited file access"
        }
    } catch {
        Write-Error "Failed to save Claude configuration"
        Write-Error "Error: $($_.Exception.Message)"
        if (Test-Path "$configPath.backup-*") {
            Write-Info "You can restore from backup if needed"
        }
        exit 1
    }
}

function Show-Status {
    Write-Header
    Write-Info "Checking installation status..."
    Write-Host ""

    try {
        $null = docker info 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Docker daemon: Running"
        } else {
            Write-Warning "Docker daemon: Not running"
        }
    } catch {
        Write-Warning "Docker: Not available"
    }

    try {
        $null = docker image inspect desktop-commander:latest 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Docker image: Available"
        } else {
            Write-Warning "Docker image: Missing"
        }
    } catch {
        Write-Warning "Docker image: Cannot check"
    }

    $volumes = @("dc-system", "dc-home", "dc-workspace", "dc-packages")
    $volumesFound = 0

    Write-Host ""
    Write-Info "Persistent Volumes Status:"

    foreach ($volume in $volumes) {
        try {
            $null = docker volume inspect $volume 2>$null
            if ($LASTEXITCODE -eq 0) {
                $volumesFound++
                Write-Success "  OK: $volume"
            } else {
                Write-Warning "  MISSING: $volume"
            }
        } catch {
            Write-Warning "  UNKNOWN: $volume (cannot check)"
        }
    }

    $configPath = "$env:APPDATA\Claude\claude_desktop_config.json"
    if (Test-Path $configPath) {
        try {
            $config = Get-Content $configPath | ConvertFrom-Json
            if ($config.mcpServers."desktop-commander") {
                Write-Success "Claude config: Desktop Commander configured"
            } else {
                Write-Warning "Claude config: Missing Desktop Commander server"
            }
        } catch {
            Write-Warning "Claude config: Cannot parse"
        }
    } else {
        Write-Warning "Claude config: File not found"
    }

    Write-Host ""
    Write-Host "Status Summary:" -ForegroundColor Yellow
    Write-Host "  Essential volumes: $volumesFound/4 found"
    Write-Host "  Container mode: Auto-remove (fresh containers)"
    Write-Host "  Persistence: Data stored in volumes"

    Write-Host ""
    if ($volumesFound -eq 4) {
        Write-Success "Ready to use with Claude!"
        Write-Info "Each command creates a fresh container that uses your persistent volumes."
    } elseif ($volumesFound -gt 0) {
        Write-Warning "Some volumes missing - may need to reinstall"
        Write-Info "Run reset and reinstall to fix this"
    } else {
        Write-Error "No volumes found - please run full installation"
        Write-Info "Run: .\install-docker-clean.ps1"
    }
}function Reset-Installation {
    Write-Header
    Write-Warning "This will remove ALL persistent container data!"
    Write-Info "This includes:"
    Write-Info "  - All installed packages and software"
    Write-Info "  - All user configurations and settings"
    Write-Info "  - All development projects in /workspace"
    Write-Info "  - All package caches and databases"
    Write-Host ""
    Write-Info "Your mounted folders will NOT be affected."
    Write-Host ""

    $confirm = Read-Host "Are you sure you want to reset everything? [y/N]"
    if ($confirm -match "^[yY]") {
        Write-Info "Cleaning up containers and volumes..."

        try {
            $containers = docker ps -q --filter "ancestor=mcp/desktop-commander:latest" 2>$null
            if ($containers -and $LASTEXITCODE -eq 0) {
                docker stop $containers 2>$null | Out-Null
                docker rm $containers 2>$null | Out-Null
                Write-Info "Stopped running containers"
            }
        } catch {
            # Ignore errors here
        }

        Write-Info "Removing persistent volumes..."
        $volumes = @("dc-system", "dc-home", "dc-workspace", "dc-packages")
        $removedCount = 0

        foreach ($volume in $volumes) {
            try {
                docker volume rm $volume 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Removed volume: $volume"
                    $removedCount++
                } else {
                    Write-Warning "Volume $volume is still in use or doesn't exist"
                }
            } catch {
                Write-Warning "Error removing volume: $volume"
            }
        }

        Write-Host ""
        Write-Success "Persistent data reset complete!"
        if ($removedCount -gt 0) {
            Write-Success "Successfully removed $removedCount volume(s)"
        }
        Write-Host ""
        Write-Info "To reinstall after reset:"
        Write-Info "Run: .\install-docker-clean.ps1"
    } else {
        Write-Info "Reset cancelled"
    }
}

function Show-Help {
    Write-Host "Desktop Commander Docker Installation (Enhanced)" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\install-docker-clean.ps1                 - Interactive installation with folder selection"
    Write-Host "  .\install-docker-clean.ps1 -Status         - Check installation status"
    Write-Host "  .\install-docker-clean.ps1 -Reset          - Reset all data"
    Write-Host "  .\install-docker-clean.ps1 -VerboseOutput  - Show detailed output"
    Write-Host "  .\install-docker-clean.ps1 -Help           - Show this help"
    Write-Host ""
    Write-Host "Features:"
    Write-Host "  - Interactive folder selection (like Mac version)"
    Write-Host "  - Custom folder mounting outside home directory"
    Write-Host "  - Persistent development environment"
    Write-Host "  - Enhanced configuration options"
    Write-Host ""
    Write-Host "Troubleshooting:"
    Write-Host "If you broke the Docker container or need a fresh start:"
    Write-Host "  .\install-docker-clean.ps1 -Reset"
    Write-Host "  .\install-docker-clean.ps1"
    Write-Host ""
    Write-Host "This will completely reset your persistent environment and reinstall everything fresh."
}

function Start-Installation {
    Write-Header

    if ($Help) {
        Show-Help
        return
    }

    if ($Status) {
        Show-Status
        return
    }

    if ($Reset) {
        Reset-Installation
        return
    }

    Test-Docker
    Get-DockerImage
    Ask-ForFolders
    Initialize-Volumes
    Build-DockerArgs
    Update-ClaudeConfig
    Restart-Claude

    Write-Host ""
    Write-Success "Installation successfully completed! Thank you for using Desktop Commander!"
    Write-Host ""
    Write-Info "How it works:"
    Write-Info "- Desktop Commander runs in isolated containers"
    Write-Info "- Your development tools and configs persist between uses"
    Write-Info "- Each command creates a fresh, clean container"
    
    if ($script:Folders.Count -gt 0) {
        Write-Host ""
        Write-Info "Your accessible folders (dual mount paths):"
        foreach ($folder in $script:Folders) {
            $folderName = Split-Path $folder -Leaf
            Write-Info "  Folder: $folder"
            Write-Info "    -> /home/$folderName (home-style)"
            
            # Show Windows-style path too
            $windowsPath = $folder.Replace('\', '/')
            if ($windowsPath -match '^([A-Za-z]):(.*)') {
                $windowsStylePath = "/$($matches[1].ToLower())$($matches[2])"
                Write-Info "    -> $windowsStylePath (windows-style)"
            }
        }
        Write-Host ""
        Write-Info "Path Translation Examples:"
        Write-Info "  Windows: C:\Users\wonde\projects\file.txt"
        Write-Info "  Docker:  /c/users/wonde/projects/file.txt  (windows-style)"
        Write-Info "  Docker:  /home/wonde/projects/file.txt     (home-style)"
    }
    
    Write-Host ""
    Write-Info "To refresh/reset your persistent environment:"
    Write-Info "- Run: .\install-docker-clean.ps1 -Reset"
    Write-Info "- This removes all installed packages and resets everything"
    Write-Host ""
    Write-Info "If you broke the Docker container or need a fresh start:"
    Write-Info "- Run: .\install-docker-clean.ps1 -Reset"
    Write-Info "- Then: .\install-docker-clean.ps1"
    Write-Info "- This will reset everything and reinstall from scratch"
    Write-Host ""
    Write-Info "Claude Desktop has been automatically restarted (if possible)"
    Write-Success "Desktop Commander is available as 'desktop-commander' in Claude"
    
    Write-Host ""
    Write-Info "Next steps: Install anything you want - it will persist!"
    Write-Info "- Global packages: npm install -g typescript"  
    Write-Info "- User configs: git config, SSH keys, .bashrc"

    Write-Host ""
    Write-Info "Need help or have feedback? Happy to jump on a quick call:"
    Write-Info "   https://calendar.app.google/SHMNZN5MJznJWC5A7"
    Write-Host ""
    Write-Info "Join our community: https://discord.com/invite/kQ27sNnZr7"
}

# Run installation
Start-Installation