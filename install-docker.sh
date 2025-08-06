#!/bin/bash

# Desktop Commander Docker Installation Script - Essential Persistence
# Simplified approach with essential volumes for complete development persistence

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Docker image - can be changed to latest
DOCKER_IMAGE="mcp/desktop-commander:latest"
CONTAINER_NAME="desktop-commander"

print_header() {
    echo
    echo -e "${BLUE}██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗██████╗${NC}"
    echo -e "${BLUE}██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔══██╗${NC}"
    echo -e "${BLUE}██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝   ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║█████╗  ██████╔╝${NC}"
    echo -e "${BLUE}██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗${NC}"
    echo -e "${BLUE}██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║        ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████╗██║  ██║${NC}"
    echo -e "${BLUE}╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝         ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝${NC}"
    echo
    echo -e "${BLUE}🐳 Docker Installation - Essential Persistence${NC}"
    echo
    print_info "🛡️ Secure sandbox environment that won't mess up your main computer - experiment without worry"
    print_warning "Files in mounted folders will be modified on your host machine"
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
        *)        print_error "Unsupported OS: $OSTYPE" ; exit 1 ;;
    esac
}

# Get Claude config path based on OS
get_claude_config_path() {
    case "$OS" in
        "macos")
            CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
            ;;
        "linux")
            CLAUDE_CONFIG="$HOME/.config/claude/claude_desktop_config.json"
            ;;
    esac
}

# Check if Docker is available
check_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        print_error "Docker is not installed or not in PATH"
        echo
        echo "Please install Docker first:"
        case "$OS" in
            "macos")
                echo "  • Download Docker Desktop from: https://www.docker.com/products/docker-desktop/"
                ;;
            "linux")
                echo "  • Install Docker Engine: https://docs.docker.com/engine/install/"
                ;;
        esac
        exit 1
    fi

    if ! docker info >/dev/null 2>&1; then
        print_error "Docker is not running"
        echo "Please start Docker and try again"
        exit 1
    fi

    print_success "Docker is available and running"
}

# Pull the Docker image
pull_docker_image() {
    echo
    print_info "Ready to download Desktop Commander Docker image (~500MB)"
    echo -n "Press Enter to continue or Ctrl+C to cancel: "
    read -r

    print_info "Downloading image..."
    if docker pull "$DOCKER_IMAGE" >/dev/null 2>&1; then
        print_success "Docker image downloaded"
    else
        print_error "Failed to download Docker image"
        exit 1
    fi
}

# Ask user which folders to mount
ask_for_folders() {
    echo
    echo -e "${BLUE}📁 Folder Access Setup${NC}"
    print_info "Desktop Commander runs in isolation - only selected folders are accessible"
    echo

    FOLDERS=()

    # Ask for complete user home directory first
    echo -n "Mount your complete home directory ($HOME)? [Y/n]: "
    read -r response
    case "$response" in
        [nN]|[nN][oO])
            print_info "Skipping home directory"
            ;;
        *)
            FOLDERS+=("$HOME")
            print_success "Added home directory access"
            ;;
    esac

    # Ask for additional folders
    echo
    print_info "Add extra folders outside home directory (optional):"

    while true; do
        echo -n "Enter folder path (or Enter to finish): "
        read -r custom_dir

        if [ -z "$custom_dir" ]; then
            break
        fi

        custom_dir="${custom_dir/#\~/$HOME}"

        if [ -d "$custom_dir" ]; then
            FOLDERS+=("$custom_dir")
            print_success "Added: $custom_dir"
        else
            echo -n "Folder doesn't exist. Add anyway? [y/N]: "
            read -r add_anyway
            if [[ $add_anyway =~ ^[Yy]$ ]]; then
                FOLDERS+=("$custom_dir")
                print_info "Added: $custom_dir (will create if needed)"
            fi
        fi
    done

    if [ ${#FOLDERS[@]} -eq 0 ]; then
        print_warning "No folders selected - container will have no file access"
        echo -n "Continue anyway? [y/N]: "
        read -r confirm
        if [[ ! $confirm =~ ^[Yy]$ ]]; then
            exit 0
        fi
    else
        print_success "Selected ${#FOLDERS[@]} folders"
    fi
}

# Setup essential volumes for maximum persistence
setup_persistent_volumes() {
    echo
    print_info "🔧 Setting up persistent development environment"

    # Essential volumes that cover everything a developer needs
    ESSENTIAL_VOLUMES=(
        "dc-system:/usr"                        # All system packages, binaries, libraries
        "dc-home:/root"                         # User configs, dotfiles, SSH keys, git config
        "dc-workspace:/workspace"               # Development files and projects
        "dc-packages:/var"                      # Package databases, caches, logs
    )

    for volume in "${ESSENTIAL_VOLUMES[@]}"; do
        volume_name=$(echo "$volume" | cut -d':' -f1)
        if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
            docker volume create "$volume_name" >/dev/null 2>&1
        fi
    done

    print_success "Persistent environment ready - your tools will survive restarts"
}

# Build Docker run arguments
build_docker_args() {
    print_info "Building Docker configuration..."

    # Start with base arguments (use --rm so containers auto-remove after each use)
    DOCKER_ARGS=("run" "-i" "--rm")

    # Add essential persistent volumes
    for volume in "${ESSENTIAL_VOLUMES[@]}"; do
        DOCKER_ARGS+=("-v" "$volume")
    done

    # Add user folder mounts (separate from system volumes)
    for folder in "${FOLDERS[@]}"; do
        folder_name=$(basename "$folder")
        DOCKER_ARGS+=("-v" "$folder:/mnt/$folder_name")
    done

    # Add the image
    DOCKER_ARGS+=("$DOCKER_IMAGE")

    print_success "Docker configuration ready"
    print_info "Essential volumes: ${#ESSENTIAL_VOLUMES[@]} volumes"
    print_info "Mounted folders: ${#FOLDERS[@]} folders"
    print_info "Container mode: Auto-remove after each use (--rm)"
}

# Update Claude desktop config
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

    # Use Python to update JSON (preserves existing MCP servers)
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

# Configure to use docker run with essential volumes
config['mcpServers']['desktop-commander-in-docker'] = {
    'command': 'docker',
    'args': docker_args
}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)

print('Successfully updated Claude config')
" || {
        print_error "Failed to update Claude config with Python"
        exit 1
    }

    print_success "Updated Claude config: $CLAUDE_CONFIG"
    print_info "Desktop Commander will be available as 'desktop-commander-in-docker' in Claude"
}

# Test the persistent setup
test_persistence() {
    print_info "Testing persistent container setup..."

    print_info "Testing essential volumes with a temporary container..."

    # Test that essential paths are available for persistence
    if docker "${DOCKER_ARGS[@]}" /bin/bash -c "
        echo 'Testing persistence paths...'
        mkdir -p /workspace/test
        echo 'test-data' > /workspace/test/file.txt &&
        echo 'Workspace persistence: OK'
        touch /root/.test_config &&
        echo 'Home persistence: OK'
        echo 'Container test completed successfully'
    " >/dev/null 2>&1; then
        print_success "Essential persistence test passed"
        print_info "Volumes are working correctly"
    else
        print_warning "Some persistence tests had issues (might still work)"
    fi
}

# Show container management commands
show_management_info() {
    echo
    print_success "🎉 Setup complete!"
    echo
    print_info "How it works:"
    echo "• Desktop Commander runs in isolated containers"
    echo "• Your development tools and configs persist between uses"
    echo "• Each command creates a fresh, clean container"
    echo
    print_info "To refresh/reset your persistent environment:"
    echo "• Run: $0 --reset"
    echo "• This removes all installed packages and resets everything"
}

# Reset all persistent data
reset_persistence() {
    echo
    print_warning "This will remove ALL persistent container data!"
    echo "This includes:"
    echo "  • All installed packages and software"
    echo "  • All user configurations and settings"
    echo "  • All development projects in /workspace"
    echo "  • All package caches and databases"
    echo
    print_info "Your mounted folders will NOT be affected."
    echo
    read -p "Are you sure you want to reset everything? [y/N]: " -r
    case "$REPLY" in
        [yY]|[yY][eE][sS])
            print_info "Stopping and removing container..."
            docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
            docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true

            print_info "Removing essential volumes..."
            local volumes=("dc-system" "dc-home" "dc-workspace" "dc-packages")
            for volume in "${volumes[@]}"; do
                if docker volume rm "$volume" >/dev/null 2>&1; then
                    print_success "Removed volume: $volume"
                else
                    print_warning "Failed to remove volume: $volume (may not exist)"
                fi
            done

            print_success "All persistent data has been reset"
            echo "Run the installer again to set up a fresh container."
            ;;
        *)
            print_info "Reset cancelled"
            ;;
    esac
}

# Show status of current setup
show_status() {
    echo
    print_header

    # Check essential volumes
    local volumes=("dc-system" "dc-home" "dc-workspace" "dc-packages")
    local volumes_found=0

    echo "Essential volumes status:"
    for volume in "${volumes[@]}"; do
        if docker volume inspect "$volume" >/dev/null 2>&1; then
            local mountpoint
            mountpoint=$(docker volume inspect "$volume" --format '{{.Mountpoint}}' 2>/dev/null || echo "unknown")
            local size
            size=$(sudo du -sh "$mountpoint" 2>/dev/null | cut -f1 || echo "unknown")
            echo "  ✅ $volume ($size)"
            ((volumes_found++))
        else
            echo "  ❌ $volume (missing)"
        fi
    done

    echo
    echo "Status Summary:"
    echo "  Essential volumes: $volumes_found/4 found"
    echo "  Container mode: Auto-remove (--rm)"
    echo "  Persistence: Data stored in volumes"

    echo
    if [ "$volumes_found" -eq 4 ]; then
        echo "✅ Ready to use with Claude!"
        echo "Each command creates a fresh container that uses your persistent volumes."
    elif [ "$volumes_found" -gt 0 ]; then
        echo "⚠️  Some volumes missing - may need to reinstall"
    else
        echo "🚀 Run the installer to create your persistent volumes"
    fi
}

# Try to restart Claude automatically
restart_claude() {
    print_info "Attempting to restart Claude..."

    case "$OS" in
        macos)
            # Kill Claude if running
            if pgrep -f "Claude" > /dev/null; then
                killall "Claude" 2>/dev/null || true
                sleep 2
                print_info "Stopped Claude"
            fi
            # Try to start Claude
            if command -v open &> /dev/null; then
                if open -a "Claude" 2>/dev/null; then
                    print_success "Claude restarted successfully"
                else
                    print_warning "Could not auto-start Claude. Please start it manually."
                fi
            else
                print_warning "Could not auto-restart Claude. Please start it manually."
            fi
            ;;
        linux)
            # Kill Claude if running
            if pgrep -f "claude" > /dev/null; then
                pkill -f "claude" 2>/dev/null || true
                sleep 2
                print_info "Stopped Claude"
            fi
            # Try to start Claude
            if command -v claude &> /dev/null; then
                if claude &>/dev/null & disown; then
                    print_success "Claude restarted successfully"
                else
                    print_warning "Could not auto-start Claude. Please start it manually."
                fi
            else
                print_warning "Could not auto-restart Claude. Please start it manually."
            fi
            ;;
    esac
}

# Help message
show_help() {
    print_header
    echo "Usage: $0 [OPTION]"
    echo
    echo "Options:"
    echo "  (no args)    Interactive installation"
    echo "  --reset      Remove all persistent data"
    echo "  --status     Show current status"
    echo "  --help       Show this help"
    echo
    echo "Creates a persistent development container using 4 essential volumes:"
    echo "  • dc-system: System packages and binaries (/usr)"
    echo "  • dc-home: User configurations (/root)"
    echo "  • dc-workspace: Development projects (/workspace)"
    echo "  • dc-packages: Package databases and caches (/var)"
    echo
    echo "This covers 99% of development persistence needs with simple management."
    echo
}

# Main execution logic
case "${1:-}" in
    --reset)
        print_header
        reset_persistence
        exit 0
        ;;
    --status)
        show_status
        exit 0
        ;;
    --help)
        show_help
        exit 0
        ;;
    ""|--install)
        # Main installation flow
        ;;
    *)
        print_error "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
        ;;
esac

# Main installation flow
print_header

detect_os
print_success "Detected OS: $OS"

get_claude_config_path
print_info "Claude config path: $CLAUDE_CONFIG"

check_docker
pull_docker_image
ask_for_folders
setup_persistent_volumes
build_docker_args
update_claude_config
test_persistence
restart_claude
show_management_info

echo
print_success "✅ Claude has been restarted (if possible)"
print_info "Desktop Commander is available as 'desktop-commander-in-docker' in Claude"
echo
print_info "Next steps: Install anything you want - it will persist!"
echo "• System packages: apt install nodejs python3-pip"
echo "• Global packages: npm install -g typescript"
echo "• User configs: git config, SSH keys, .bashrc"
