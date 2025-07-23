#!/bin/bash

# Desktop Commander Docker Installation Script
# Cross-platform installer for macOS and Linux

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Docker image - can be changed to latest
DOCKER_IMAGE="mcp/desktop-commander:latest"

print_header() {
    echo
    echo -e "${BLUE}██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗██████╗${NC}"
    echo -e "${BLUE}██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔══██╗${NC}"
    echo -e "${BLUE}██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝   ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║█████╗  ██████╔╝${NC}"
    echo -e "${BLUE}██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗${NC}"
    echo -e "${BLUE}██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║        ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████╗██║  ██║${NC}"
    echo -e "${BLUE}╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝         ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝${NC}"
    echo
    echo -e "${BLUE}🐳 Docker Installation${NC}"
    echo
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ Error: $1${NC}" >&2
}

print_warning() {
    echo -e "${YELLOW}⚠️  Warning: $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Detect OS
detect_os() {
    case "$OSTYPE" in
        darwin*)  OS="macos" ;;
        linux*)   OS="linux" ;;
        *)        print_error "Unsupported OS: $OSTYPE"; exit 1 ;;
    esac
}

# Get Claude config path based on OS
get_claude_config_path() {
    case "$OS" in
        macos)
            CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
            ;;
        linux)
            CLAUDE_CONFIG="$HOME/.config/Claude/claude_desktop_config.json"
            ;;
    esac
}

# Check if Docker is installed and running
check_docker() {
    print_info "Checking Docker installation..."
    
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed."
        print_info "Please install Docker Desktop from: https://www.docker.com/products/docker-desktop/"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        print_error "Docker is not running."
        print_info "Please start Docker Desktop and try again."
        exit 1
    fi
    
    print_success "Docker is installed and running"
}

# Pull the Docker image
pull_docker_image() {
    print_info "Pulling Desktop Commander Docker image..."
    if docker pull "$DOCKER_IMAGE"; then
        print_success "Docker image pulled successfully"
    else
        print_error "Failed to pull Docker image"
        exit 1
    fi
}

# Build Docker run arguments for Claude config
build_docker_args() {
    print_info "Building Docker configuration..."
    
    # Start with base arguments
    DOCKER_ARGS=("run" "-i" "--rm")
    
    # Add volume mounts
    for folder in "${FOLDERS[@]}"; do
        folder_name=$(basename "$folder")
        DOCKER_ARGS+=("-v" "$folder:/mnt/$folder_name")
    done
    
    # Add the image
    DOCKER_ARGS+=("$DOCKER_IMAGE")
    
    print_success "Docker configuration built with ${#FOLDERS[@]} mounted folders"
}

# Ask user for folders to mount
ask_for_folders() {
    echo
    print_info "Which folders would you like Desktop Commander to access?"
    echo "Enter folder paths (one per line). Press Enter twice when done:"
    echo "Examples:"
    case "$OS" in
        macos)
            echo "  /Users/$USER/Desktop"
            echo "  /Users/$USER/Documents"
            echo "  /Users/$USER/Projects"
            ;;
        linux)
            echo "  /home/$USER/Desktop"
            echo "  /home/$USER/Documents" 
            echo "  /home/$USER/Projects"
            ;;
    esac
    echo
    
    FOLDERS=()
    while true; do
        read -r folder
        if [[ -z "$folder" ]]; then
            break
        fi
        
        # Expand ~ to home directory
        folder="${folder/#\~/$HOME}"
        
        # Check if folder exists
        if [[ -d "$folder" ]]; then
            FOLDERS+=("$folder")
            print_success "Added: $folder"
        else
            print_warning "Folder does not exist: $folder"
            read -p "Add anyway? (y/N): " -r
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                FOLDERS+=("$folder")
                print_info "Added: $folder"
            fi
        fi
    done
    
    if [[ ${#FOLDERS[@]} -eq 0 ]]; then
        print_warning "No folders selected. Desktop Commander will run with limited file access."
        read -p "Continue anyway? (y/N): " -r
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Installation cancelled."
            exit 0
        fi
    fi
}

# Create or update Claude config
update_claude_config() {
    print_info "Updating Claude Desktop configuration..."
    
    # Create config directory if it doesn't exist
    CONFIG_DIR=$(dirname "$CLAUDE_CONFIG")
    if [[ ! -d "$CONFIG_DIR" ]]; then
        mkdir -p "$CONFIG_DIR"
        print_info "Created config directory: $CONFIG_DIR"
    fi
    
    # Create config if it doesn't exist
    if [[ ! -f "$CLAUDE_CONFIG" ]]; then
        echo '{"mcpServers": {}}' > "$CLAUDE_CONFIG"
        print_info "Created new Claude config file"
    fi
    
    # Convert DOCKER_ARGS array to JSON format
    ARGS_JSON="["
    for i in "${!DOCKER_ARGS[@]}"; do
        if [[ $i -gt 0 ]]; then
            ARGS_JSON+=", "
        fi
        ARGS_JSON+="\"${DOCKER_ARGS[$i]}\""
    done
    ARGS_JSON+="]"
    
    # Use Python to update JSON (more reliable than jq)
    python3 -c "
import json
import sys

config_path = '$CLAUDE_CONFIG'
docker_args = $ARGS_JSON

try:
    with open(config_path, 'r') as f:
        config = json.load(f)
except:
    config = {'mcpServers': {}}

if 'mcpServers' not in config:
    config['mcpServers'] = {}

# Configure to use docker run with volumes
config['mcpServers']['desktop-commander'] = {
    'command': 'docker',
    'args': docker_args
}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)

print('✅ Claude configuration updated')
" || {
        print_error "Failed to update Claude config. Python3 is required."
        print_info "Please install Python3 or manually update your Claude config."
        exit 1
    }
}

# Try to restart Claude
restart_claude() {
    print_info "Attempting to restart Claude..."
    
    case "$OS" in
        macos)
            # Kill Claude if running
            if pgrep -f "Claude" > /dev/null; then
                killall "Claude" 2>/dev/null || true
                sleep 2
            fi
            # Try to start Claude
            if command -v open &> /dev/null; then
                open -a "Claude" 2>/dev/null || print_warning "Could not auto-start Claude. Please start it manually."
            fi
            ;;
        linux)
            # Kill Claude if running
            if pgrep -f "claude" > /dev/null; then
                pkill -f "claude" 2>/dev/null || true
                sleep 2
            fi
            # Try to start Claude
            if command -v claude &> /dev/null; then
                claude &>/dev/null & disown || print_warning "Could not auto-start Claude. Please start it manually."
            fi
            ;;
    esac
}

# Main installation function
main() {
    print_header
    
    detect_os
    print_success "Detected OS: $OS"
    
    get_claude_config_path
    print_info "Claude config path: $CLAUDE_CONFIG"
    
    check_docker
    pull_docker_image
    ask_for_folders
    build_docker_args
    update_claude_config
    restart_claude
    
    echo
    print_success "🎉 Desktop Commander Docker installation completed!"
    echo
    print_info "What was installed:"
    echo "  • Docker image: $DOCKER_IMAGE"
    echo "  • Mounted folders: ${#FOLDERS[@]} folders"
    echo "  • Claude config: Updated with ephemeral containers"
    echo
    print_info "Next steps:"
    echo "  1. Restart Claude Desktop if it's running"
    echo "  2. Desktop Commander will be available as 'desktop-commander' in Claude"
    echo "  3. Each tool call uses a fresh, clean container"
    echo
    print_info "✅ Installation successfully completed! Thank you for using Desktop Commander!"
    echo "The server is available as \"desktop-commander\" in Claude's MCP server list"
    echo "Future updates will install automatically — no need to run this setup again."
    echo
    print_info "💬 Need help or found an issue? Join our community: https://discord.com/invite/kQ27sNnZr7"
    echo
    print_info "To uninstall:"
    echo "  • Remove 'desktop-commander' from Claude config"
    echo
}

# Run main function
main "$@"