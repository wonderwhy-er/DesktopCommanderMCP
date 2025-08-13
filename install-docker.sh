#!/bin/bash

# Desktop Commander Docker Installation Script

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

# Global flag for verbose output
VERBOSE=false

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
    print_info "Experiment with AI in secure sandbox environment that won't mess up your main computer"
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

print_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}ℹ️  $1${NC}"
    fi
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
    while true; do
        if ! command -v docker >/dev/null 2>&1; then
            print_error "Docker is not installed or not found"
            echo
            print_error "Please install Docker first:"
            case "$OS" in
                "macos")
                    print_error "• Download Docker Desktop: https://www.docker.com/products/docker-desktop/"
                    ;;
                "linux")
                    print_error "• Install Docker Engine: https://docs.docker.com/engine/install/"
                    ;;
            esac
            echo
            echo -n "Press Enter when Docker Desktop is running or Ctrl+C to exit: "
            read -r
            continue
        fi

        if ! docker info >/dev/null 2>&1; then
            print_error "Docker is installed but not running"
            echo
            print_error "Please start Docker Desktop and try again"
            echo
            echo -n "Press Enter when Docker Desktop is running or Ctrl+C to exit: "
            read -r
            continue
        fi

        # If we get here, Docker is working
        break
    done

    print_success "Docker is available and running"
}

# Pull the Docker image
pull_docker_image() {
    print_info "Pulling latest Docker image (this may take a moment)..."
    
    if docker pull "$DOCKER_IMAGE"; then
        print_success "Docker image ready: $DOCKER_IMAGE"
    else
        print_error "Failed to pull Docker image"
        print_info "Check your internet connection and Docker Hub access"
        exit 1
    fi
}

# Ask user which folders to mount
ask_for_folders() {
    echo
    echo -e "${BLUE}📁 Folder Access Setup${NC}"
    print_info "By default, Desktop Commander will have access to your user folder:"
    print_info "📂 $HOME"
    echo
    echo -n "Press Enter to accept user folder access or 'y' to customize: "
    read -r response
    
    FOLDERS=()
    
    if [[ $response =~ ^[Yy]$ ]]; then
        # Custom folder selection
        echo
        print_info "Custom folder selection:"
        echo -n "Mount your complete home directory ($HOME)? [Y/n]: "
        read -r home_response
        case "$home_response" in
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
            echo
            print_warning "⚠️  No folders selected - Desktop Commander will have NO file access"
            echo
            print_info "This means:"
            echo "  • Desktop Commander cannot read or write any files on your computer"
            echo "  • It cannot help with coding projects, file management, or document editing"
            echo "  • It will only work for system commands and package installation"
            echo "  • This makes Desktop Commander much less useful than intended"
            echo
            print_info "You probably want to share at least some folder to work with files"
            print_info "Most users share their home directory: $HOME"
            echo
            echo -n "Continue with NO file access? [y/N]: "
            read -r confirm
            if [[ ! $confirm =~ ^[Yy]$ ]]; then
                print_info "Restarting folder selection..."
                ask_for_folders
                return
            fi
            print_warning "Proceeding with no file access - Desktop Commander will be limited"
        fi
    else
        # Default: use home directory
        FOLDERS+=("$HOME")
        print_success "Using default access to your user folder"
    fi
}

# Setup essential volumes for maximum persistence
setup_persistent_volumes() {
    print_verbose "🔧 Setting up persistent development environment"

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

    print_verbose "Persistent environment ready - your tools will survive restarts"
}

# Build Docker run arguments
build_docker_args() {
    print_verbose "Building Docker configuration..."

    # Start with base arguments (use --rm so containers auto-remove after each use)
    DOCKER_ARGS=("run" "-i" "--rm")

    # Add essential persistent volumes
    for volume in "${ESSENTIAL_VOLUMES[@]}"; do
        DOCKER_ARGS+=("-v" "$volume")
    done

    # Add user folder mounts with absolute path structure
    for folder in "${FOLDERS[@]}"; do
        # Remove leading /Users/username or /home/username and keep absolute structure
        if [[ "$folder" =~ ^/Users/[^/]+(/.+)$ ]]; then
            # Mac: /Users/john/projects/data → /home/projects/data  
            absolute_path="${BASH_REMATCH[1]}"
            DOCKER_ARGS+=("-v" "$folder:/home$absolute_path")
        elif [[ "$folder" =~ ^/home/[^/]+(/.+)$ ]]; then
            # Linux: /home/john/projects/data → /home/projects/data
            absolute_path="${BASH_REMATCH[1]}"
            DOCKER_ARGS+=("-v" "$folder:/home$absolute_path")
        else
            # Fallback for other paths - use basename
            folder_name=$(basename "$folder")
            DOCKER_ARGS+=("-v" "$folder:/home/$folder_name")
        fi
    done

    # Add the image
    DOCKER_ARGS+=("$DOCKER_IMAGE")

    print_verbose "Docker configuration ready"
    print_verbose "Essential volumes: ${#ESSENTIAL_VOLUMES[@]} volumes"
    print_verbose "Mounted folders: ${#FOLDERS[@]} folders"
    print_verbose "Container mode: Auto-remove after each use (--rm)"
}

# Update Claude desktop config
update_claude_config() {
    print_verbose "Updating Claude Desktop configuration..."

    # Create config directory if it doesn't exist
    CONFIG_DIR=$(dirname "$CLAUDE_CONFIG")
    if [[ ! -d "$CONFIG_DIR" ]]; then
        mkdir -p "$CONFIG_DIR"
        print_verbose "Created config directory: $CONFIG_DIR"
    fi

    # Create config if it doesn't exist
    if [[ ! -f "$CLAUDE_CONFIG" ]]; then
        echo '{"mcpServers": {}}' > "$CLAUDE_CONFIG"
        print_verbose "Created new Claude config file"
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
config['mcpServers']['desktop-commander'] = {
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

    print_verbose "Updated Claude config: $CLAUDE_CONFIG"
    print_verbose "Desktop Commander will be available as 'desktop-commander' in Claude"
}

# Test the persistent setup
test_persistence() {
    print_verbose "Testing persistent container setup..."

    print_verbose "Testing essential volumes with a temporary container..."

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
        print_verbose "Essential persistence test passed"
        print_verbose "Volumes are working correctly"
    else
        print_verbose "Some persistence tests had issues (might still work)"
    fi
}

# Show container management commands
show_management_info() {
    echo
    print_success "🎉 Installation successfully completed! Thank you for using Desktop Commander!"
    echo
    print_info "How it works:"
    echo "• Desktop Commander runs in isolated containers"
    echo "• Your development tools and configs persist between uses"
    echo "• Each command creates a fresh, clean container"
    echo
    print_info "🤔 Need help or have feedback? Happy to jump on a quick call:"
    echo "   https://calendar.app.google/SHMNZN5MJznJWC5A7"
    echo
    print_info "💬 Join our community: https://discord.com/invite/kQ27sNnZr7"
    echo
    print_info "💡 If you broke the Docker container or need a fresh start:"
    echo "• Run: $0 --reset && $0"
    echo "• This will reset everything and reinstall from scratch"
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
            print_info "Cleaning up containers and volumes..."
            
            # Stop and remove any containers that might be using our volumes
            print_verbose "Stopping any running Desktop Commander containers..."
            docker ps -q --filter "ancestor=$DOCKER_IMAGE" | xargs -r docker stop >/dev/null 2>&1 || true
            docker ps -a -q --filter "ancestor=$DOCKER_IMAGE" | xargs -r docker rm >/dev/null 2>&1 || true
            
            # Also try by container name if it exists
            docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
            docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true

            print_info "Removing persistent volumes..."
            local volumes=("dc-system" "dc-home" "dc-workspace" "dc-packages")
            local failed_volumes=()
            
            for volume in "${volumes[@]}"; do
                if docker volume rm "$volume" >/dev/null 2>&1; then
                    print_success "✅ Removed volume: $volume"
                else
                    failed_volumes+=("$volume")
                    print_warning "⚠️  Volume $volume is still in use or doesn't exist"
                fi
            done
            
            # If some volumes failed, try harder cleanup
            if [ ${#failed_volumes[@]} -gt 0 ]; then
                print_info "Attempting force cleanup of remaining volumes..."
                # Remove ALL containers that might be holding references (more aggressive)
                docker container prune -f >/dev/null 2>&1 || true
                
                for volume in "${failed_volumes[@]}"; do
                    if docker volume rm "$volume" >/dev/null 2>&1; then
                        print_success "✅ Force removed volume: $volume"
                    else
                        print_error "❌ Could not remove volume: $volume"
                        print_info "Manual cleanup needed: docker volume rm $volume"
                    fi
                done
            fi

            print_success "🎉 Persistent data reset complete!"
            echo
            print_info "Run the installer again to create a fresh environment"
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
    echo "  --verbose    Show detailed technical output"
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
    --verbose)
        VERBOSE=true
        # Continue to main installation flow
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

echo
print_success "✅ Claude has been restarted (if possible)"
print_info "Desktop Commander is available as 'desktop-commander' in Claude"
echo
print_info "Next steps: Install anything you want - it will persist!"
echo "• Global packages: npm install -g typescript"
echo "• User configs: git config, SSH keys, .bashrc"

show_management_info
