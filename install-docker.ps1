


#!/usr/bin/env powershell
param(
    [string]$Option = "",
    [switch]$Help,
    [switch]$Status,
    [switch]$Reset,
    [switch]$VerboseOutput
)

# Colors and output functions
function Write-Success { param($Message) Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Warning { param($Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Info { param($Message) Write-Host "[INFO] $Message" -ForegroundColor Blue }

function Write-Header {
    Write-Host ""
    Write-Host "██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗██████╗" -ForegroundColor Blue
    Write-Host "██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔══██╗" -ForegroundColor Blue
    Write-Host "██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝   ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║█████╗  ██████╔╝" -ForegroundColor Blue
    Write-Host "██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗" -ForegroundColor Blue
    Write-Host "██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║        ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████╗██║  ██║" -ForegroundColor Blue
    Write-Host "╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝         ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Desktop Commander Docker Installation" -ForegroundColor Blue
    Write-Host ""
    Write-Info "Experiment with AI in secure sandbox environment that won't mess up your main computer"
    Write-Host ""
}

function Test-Docker {
    while ($true) {
        # First check if docker command exists
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

        # Then check if Docker daemon is running (this is the key fix!)
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

function Update-ClaudeConfig {
    Write-Info "Updating Claude Desktop configuration..."

    $configPath = "$env:APPDATA\Claude\claude_desktop_config.json"
    Write-Info "Config location: $configPath"

    # Create directory if needed
    $configDir = Split-Path $configPath -Parent
    if (!(Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        Write-Info "Created config directory"
    }

    # Read existing config or create new
    $config = @{}
    if (Test-Path $configPath) {
        try {
            $config = Get-Content $configPath | ConvertFrom-Json -AsHashtable
            Write-Info "Loading existing Claude configuration"
        } catch {
            Write-Warning "Could not parse existing config, creating new one"
            $config = @{}
        }
    } else {
        Write-Info "Creating new Claude configuration"
    }

    # Ensure mcpServers section exists
    if (!$config.mcpServers) {
        $config.mcpServers = @{}
    }

    # Add our server configuration
    $config.mcpServers["desktop-commander-in-docker"] = @{
        command = "docker"
        args = @(
            "run", "-i", "--rm",
            "-v", "dc-system:/usr",
            "-v", "dc-home:/root",
            "-v", "dc-workspace:/workspace",
            "-v", "dc-packages:/var",
            "mcp/desktop-commander:latest"
        )
    }

    # Save configuration
    try {
        # Save configuration without BOM to prevent JSON parsing issues
        $jsonConfig = $config | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($configPath, $jsonConfig, [System.Text.UTF8Encoding]::new($false))
        Write-Success "Claude configuration updated successfully"
        Write-Info "Server 'desktop-commander-in-docker' added to MCP servers"
    } catch {
        Write-Error "Failed to save Claude configuration"
        exit 1
    }
}

function Show-Status {
    Write-Header
    Write-Info "Checking installation status..."
    Write-Host ""

    # Check Docker
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

    # Check Docker image
    try {
        $null = docker image inspect mcp/desktop-commander:latest 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Docker image: Available"
        } else {
            Write-Warning "Docker image: Missing"
        }
    } catch {
        Write-Warning "Docker image: Cannot check"
    }

    # Check volumes
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

    # Check Claude config
    $configPath = "$env:APPDATA\Claude\claude_desktop_config.json"
    if (Test-Path $configPath) {
        try {
            $config = Get-Content $configPath | ConvertFrom-Json
            if ($config.mcpServers."desktop-commander-in-docker") {
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
        Write-Info "Run: .\install-docker-simple.ps1"
    }
}

function Reset-Installation {
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

        # Stop any running containers using our volumes
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
        Write-Info "Run: .\install-docker-simple.ps1"
    } else {
        Write-Info "Reset cancelled"
    }
}

function Show-Help {
    Write-Host "Desktop Commander Docker Installation" -ForegroundColor Blue
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\install-docker-simple.ps1                 - Install Desktop Commander"
    Write-Host "  .\install-docker-simple.ps1 -Status         - Check installation status"
    Write-Host "  .\install-docker-simple.ps1 -Reset          - Reset all data"
    Write-Host "  .\install-docker-simple.ps1 -Help           - Show this help"
    Write-Host ""
    Write-Host "Troubleshooting:"
    Write-Host "If you broke the Docker container or need a fresh start:"
    Write-Host "  .\install-docker-simple.ps1 -Reset"
    Write-Host "  .\install-docker-simple.ps1"
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

    # Main installation
    Test-Docker
    Get-DockerImage
    Initialize-Volumes
    Update-ClaudeConfig

    Write-Host ""
    Write-Success "Setup complete!"
    Write-Host ""
    Write-Info "How it works:"
    Write-Info "- Desktop Commander runs in isolated containers"
    Write-Info "- Your development tools and configs persist between uses"
    Write-Info "- Each command creates a fresh, clean container"
    Write-Host ""
    Write-Info "To refresh/reset your persistent environment:"
    Write-Info "- Run: .\install-docker-simple.ps1 -Reset"
    Write-Info "- This removes all installed packages and resets everything"
    Write-Host ""
    Write-Info "If you broke the Docker container or need a fresh start:"
    Write-Info "- Run: .\install-docker-simple.ps1 -Reset"
    Write-Info "- Then: .\install-docker-simple.ps1"
    Write-Info "- This will reset everything and reinstall from scratch"
    Write-Host ""
    Write-Success "Restart Claude Desktop to use Desktop Commander!"
}

# Run installation
Start-Installation
