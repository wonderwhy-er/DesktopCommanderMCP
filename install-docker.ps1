# Desktop Commander Docker Installation Script for Windows
# PowerShell script for Windows users

param(
    [switch]$Help,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# Configuration
$DOCKER_IMAGE = "mcp/desktop-commander:latest"
$CLAUDE_CONFIG = "$env:APPDATA\Claude\claude_desktop_config.json"

# Colors for output
function Write-Success { param($Message) Write-Host "✅ $Message" -ForegroundColor Green }
function Write-Error { param($Message) Write-Host "❌ Error: $Message" -ForegroundColor Red }
function Write-Warning { param($Message) Write-Host "⚠️  Warning: $Message" -ForegroundColor Yellow }
function Write-Info { param($Message) Write-Host "ℹ️  $Message" -ForegroundColor Blue }

function Write-Header {
    Write-Host ""
    Write-Host "██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗██████╗" -ForegroundColor Blue
    Write-Host "██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔══██╗" -ForegroundColor Blue
    Write-Host "██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝   ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║█████╗  ██████╔╝" -ForegroundColor Blue
    Write-Host "██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗" -ForegroundColor Blue
    Write-Host "██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║        ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████╗██║  ██║" -ForegroundColor Blue
    Write-Host "╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝         ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝" -ForegroundColor Blue
    Write-Host ""
    Write-Host "🐳 Docker Installation" -ForegroundColor Blue
    Write-Host ""
}

function Show-Help {
    Write-Header
    Write-Host "Desktop Commander Docker Installation for Windows"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  .\install-docker.ps1           Install Desktop Commander with Docker"
    Write-Host "  .\install-docker.ps1 -Help     Show this help message"
    Write-Host "  .\install-docker.ps1 -Uninstall Remove Desktop Commander Docker setup"
    Write-Host ""
    Write-Host "Prerequisites:"
    Write-Host "  • Docker Desktop for Windows"
    Write-Host "  • Claude Desktop app"
    Write-Host ""
}

function Test-Docker {
    Write-Info "Checking Docker installation..."
    
    try {
        $null = Get-Command docker -ErrorAction Stop
    } catch {
        Write-Error "Docker is not installed."
        Write-Info "Please install Docker Desktop from: https://www.docker.com/products/docker-desktop/"
        exit 1
    }
    
    try {
        $null = docker info 2>$null
        Write-Success "Docker is installed and running"
    } catch {
        Write-Error "Docker is not running."
        Write-Info "Please start Docker Desktop and try again."
        exit 1
    }
}

function Get-DockerImage {
    Write-Info "Pulling Desktop Commander Docker image..."
    try {
        docker pull $DOCKER_IMAGE
        Write-Success "Docker image pulled successfully"
    } catch {
        Write-Error "Failed to pull Docker image"
        exit 1
    }
}

function Get-FoldersToMount {
    Write-Host ""
    Write-Info "Which folders would you like Desktop Commander to access?"
    Write-Host "Enter folder paths (one per line). Press Enter twice when done:"
    Write-Host "Examples:"
    Write-Host "  C:\Users\$env:USERNAME\Desktop"
    Write-Host "  C:\Users\$env:USERNAME\Documents"
    Write-Host "  C:\Users\$env:USERNAME\Projects"
    Write-Host ""
    
    $folders = @()
    while ($true) {
        $folder = Read-Host "Folder path (or press Enter to finish)"
        if ([string]::IsNullOrWhiteSpace($folder)) {
            break
        }
        
        # Expand environment variables
        $folder = [Environment]::ExpandEnvironmentVariables($folder)
        
        # Check if folder exists
        if (Test-Path $folder -PathType Container) {
            $folders += $folder
            Write-Success "Added: $folder"
        } else {
            Write-Warning "Folder does not exist: $folder"
            $response = Read-Host "Add anyway? (y/N)"
            if ($response -eq "y" -or $response -eq "Y") {
                $folders += $folder
                Write-Info "Added: $folder"
            }
        }
    }
    
    if ($folders.Count -eq 0) {
        Write-Warning "No folders selected. Desktop Commander will run with limited file access."
        $response = Read-Host "Continue anyway? (y/N)"
        if ($response -ne "y" -and $response -ne "Y") {
            Write-Info "Installation cancelled."
            exit 0
        }
    }
    
    return $folders
}

function Build-DockerArgs {
    param($Folders)
    
    Write-Info "Building Docker configuration..."
    
    # Start with base arguments
    $dockerArgs = @("run", "-i", "--rm")
    
    # Add volume mounts
    foreach ($folder in $Folders) {
        $folderName = Split-Path $folder -Leaf
        $dockerArgs += "-v"
        $dockerArgs += "${folder}:/mnt/${folderName}"
    }
    
    # Add the image
    $dockerArgs += $DOCKER_IMAGE
    
    Write-Success "Docker configuration built with $($Folders.Count) mounted folders"
    return $dockerArgs
}

function Update-ClaudeConfig {
    param($DockerArgs)
    
    Write-Info "Updating Claude Desktop configuration..."
    
    # Create config directory if it doesn't exist
    $configDir = Split-Path $CLAUDE_CONFIG -Parent
    if (!(Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        Write-Info "Created config directory: $configDir"
    }
    
    # Load or create config
    $config = @{}
    if (Test-Path $CLAUDE_CONFIG) {
        try {
            $configContent = Get-Content $CLAUDE_CONFIG -Raw | ConvertFrom-Json
            $config = @{}
            $configContent.PSObject.Properties | ForEach-Object { $config[$_.Name] = $_.Value }
        } catch {
            Write-Warning "Could not parse existing config. Creating new one."
        }
    }
    
    # Ensure mcpServers exists
    if (!$config.mcpServers) {
        $config.mcpServers = @{}
    }
    
    # Configure to use docker run with volumes
    $config.mcpServers."desktop-commander" = @{
        command = "docker"
        args = $DockerArgs
    }
    
    # Save config
    try {
        $config | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_CONFIG -Encoding UTF8
        Write-Success "Claude configuration updated"
    } catch {
        Write-Error "Failed to update Claude config: $_"
        exit 1
    }
}

function Restart-Claude {
    Write-Info "Attempting to restart Claude..."
    
    # Kill Claude if running
    try {
        $claudeProcess = Get-Process -Name "Claude" -ErrorAction SilentlyContinue
        if ($claudeProcess) {
            Stop-Process -Name "Claude" -Force
            Start-Sleep -Seconds 2
        }
    } catch {
        # Process not running, that's fine
    }
    
    # Try to start Claude
    try {
        $claudePath = Get-Command "Claude" -ErrorAction SilentlyContinue
        if ($claudePath) {
            Start-Process "Claude"
        } else {
            Write-Warning "Could not auto-start Claude. Please start it manually."
        }
    } catch {
        Write-Warning "Could not auto-start Claude. Please start it manually."
    }
}

function Remove-Installation {
    Write-Header
    Write-Info "Uninstalling Desktop Commander Docker setup..."
    
    # Update Claude config
    if (Test-Path $CLAUDE_CONFIG) {
        try {
            $config = Get-Content $CLAUDE_CONFIG -Raw | ConvertFrom-Json
            if ($config.mcpServers -and $config.mcpServers."desktop-commander") {
                $config.mcpServers.PSObject.Properties.Remove("desktop-commander")
                $config | ConvertTo-Json -Depth 10 | Set-Content $CLAUDE_CONFIG -Encoding UTF8
                Write-Success "Removed from Claude configuration"
            }
        } catch {
            Write-Warning "Could not update Claude config. Please remove 'desktop-commander' manually."
        }
    }
    
    Write-Success "🎉 Uninstall completed!"
    exit 0
}

function Start-Installation {
    Write-Header
    
    Write-Success "Detected OS: Windows"
    Write-Info "Claude config path: $CLAUDE_CONFIG"
    
    Test-Docker
    Get-DockerImage
    $folders = Get-FoldersToMount
    $dockerArgs = Build-DockerArgs -Folders $folders
    Update-ClaudeConfig -DockerArgs $dockerArgs
    Restart-Claude
    
    Write-Host ""
    Write-Success "🎉 Desktop Commander Docker installation completed!"
    Write-Host ""
    Write-Info "What was installed:"
    Write-Host "  • Docker image: $DOCKER_IMAGE"
    Write-Host "  • Mounted folders: $($folders.Count) folders"
    Write-Host "  • Claude config: Updated with ephemeral containers"
    Write-Host ""
    Write-Info "Next steps:"
    Write-Host "  1. Restart Claude Desktop if it's running"
    Write-Host "  2. Desktop Commander will be available as 'desktop-commander' in Claude"
    Write-Host "  3. Each tool call uses a fresh, clean container"
    Write-Host ""
    Write-Info "✅ Installation successfully completed! Thank you for using Desktop Commander!"
    Write-Host "The server is available as `"desktop-commander`" in Claude's MCP server list"
    Write-Host "Future updates will install automatically — no need to run this setup again."
    Write-Host ""
    Write-Info "💬 Need help or found an issue? Join our community: https://discord.com/invite/kQ27sNnZr7"
    Write-Host ""
    Write-Info "To uninstall:"
    Write-Host "  • Run: .\install-docker.ps1 -Uninstall"
    Write-Host ""
}

# Main execution
if ($Help) {
    Show-Help
    exit 0
}

if ($Uninstall) {
    Remove-Installation
    exit 0
}

# Check execution policy
try {
    $executionPolicy = Get-ExecutionPolicy
    if ($executionPolicy -eq "Restricted") {
        Write-Warning "PowerShell execution policy is Restricted."
        Write-Info "Run this command as Administrator to allow scripts:"
        Write-Host "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser" -ForegroundColor Cyan
        exit 1
    }
} catch {
    # Continue anyway
}

Start-Installation