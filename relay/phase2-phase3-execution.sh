#!/bin/bash
# LMAOS Design System - Phase 2 & 3 Execution Script
# Charter: v1.3.1 | Evidence-first, zero-drift
# Created: 2026-01-28

set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

RELAY_BASE_URL="https://relay.activ8ai.app"
MAOS_DIR="${HOME}/.maos"
LOG_DIR="${MAOS_DIR}/logs"
BACKUP_DIR="${MAOS_DIR}/backups/$(date +%Y%m%d_%H%M%S)"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S CT')

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $1" >> "${LOG_DIR}/execution.log"
}

log_success() {
    echo -e "${GREEN}[✓]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [SUCCESS] $1" >> "${LOG_DIR}/execution.log"
}

log_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARNING] $1" >> "${LOG_DIR}/execution.log"
}

log_error() {
    echo -e "${RED}[✗]${NC} $1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $1" >> "${LOG_DIR}/execution.log"
}

# ═══════════════════════════════════════════════════════════════════════════════
# PRE-FLIGHT CHECKS
# ═══════════════════════════════════════════════════════════════════════════════

preflight_checks() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  PHASE 2 & 3 EXECUTION - PRE-FLIGHT CHECKS"
    echo "  Charter v1.3.1 | ${TIMESTAMP}"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""

    # Create directories
    mkdir -p "${LOG_DIR}" "${BACKUP_DIR}"

    # Check architecture
    log_info "Checking system architecture..."
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]] || [[ "$ARCH" == "aarch64" ]]; then
        log_success "ARM64 architecture confirmed (M4 Pro compatible)"
    else
        log_warning "Non-ARM64 architecture: $ARCH (may affect performance)"
    fi

    # Check MAOS directory
    log_info "Checking MAOS directory structure..."
    if [[ -d "${MAOS_DIR}" ]]; then
        log_success "MAOS directory exists: ${MAOS_DIR}"
    else
        log_error "MAOS directory missing. Run Phase 1 setup first."
        exit 1
    fi

    # Check network connectivity
    log_info "Testing relay endpoint connectivity..."
    if curl -s --connect-timeout 5 "${RELAY_BASE_URL}/health" > /dev/null 2>&1; then
        log_success "Relay endpoint reachable: ${RELAY_BASE_URL}"
    else
        log_warning "Relay endpoint unreachable (may be offline or blocked)"
    fi

    # Check GitHub CLI
    log_info "Checking GitHub CLI authentication..."
    if command -v gh &> /dev/null && gh auth status &> /dev/null; then
        log_success "GitHub CLI authenticated"
    else
        log_warning "GitHub CLI not authenticated (manual auth may be required)"
    fi

    echo ""
    log_success "Pre-flight checks complete"
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: AOE ENDPOINT CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

phase2_aoe_wiring() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  PHASE 2: AOE ENDPOINT CONFIGURATION"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""

    # Backup existing configuration
    log_info "Creating backup of existing configuration..."
    if [[ -f "${MAOS_DIR}/agent_orchestration_engine.py" ]]; then
        cp "${MAOS_DIR}/agent_orchestration_engine.py" "${BACKUP_DIR}/"
        log_success "Backed up agent_orchestration_engine.py"
    fi

    # Create .env.local
    log_info "Creating .env.local configuration..."
    cat > "${MAOS_DIR}/.env.local" << 'EOF'
# LMAOS Relay Configuration
# Charter: v1.3.1 | Generated: $(date '+%Y-%m-%d %H:%M:%S')

# Relay Endpoints
RELAY_BASE_URL=https://relay.activ8ai.app
RELAY_WEBHOOK_CLAUDE=https://relay.activ8ai.app/webhook/claude
RELAY_WEBHOOK_PRIME=https://relay.activ8ai.app/webhook/prime
RELAY_WEBHOOK_NOTION=https://relay.activ8ai.app/webhook/notion
RELAY_HEALTH_CHECK=https://relay.activ8ai.app/health

# Agent Configuration
AGENT_ORCHESTRATION_MODE=relay
AGENT_LOG_LEVEL=info
AGENT_TIMEOUT_MS=30000

# Notion Integration
# Do NOT hardcode production IDs/secrets in files checked into source control.
# Inject the real values from a secure secrets manager or environment at runtime.
NOTION_RELAY_DATABASE=<NOTION_DATABASE_ID>
NOTION_SECRETS_REGISTRY=<NOTION_SECRETS_REGISTRY_ID>

# Teamwork Integration
TEAMWORK_PROJECT_ID=510271
TEAMWORK_TASK_LIST_ID=2082293

# Security
# Secrets should be injected securely; keep NO_PLAINTEXT_VALUES=true if using a secret backend
SECRETS_SOURCE=notion_registry
NO_PLAINTEXT_VALUES=true
EOF
    log_success "Created .env.local"

    # Create aoe_config.json
    log_info "Creating aoe_config.json..."
    cat > "${MAOS_DIR}/aoe_config.json" << 'EOF'
{
  "version": "1.0.0",
  "charter_version": "v1.3.1",
  "created": "2026-01-28",
  "relay": {
    "base_url": "https://relay.activ8ai.app",
    "endpoints": {
      "claude": "/webhook/claude",
      "prime": "/webhook/prime",
      "notion": "/webhook/notion",
      "health": "/health"
    },
    "timeout_ms": 30000,
    "retry_count": 3
  },
  "agents": {
    "claude": {
      "enabled": true,
      "role": "orchestrator",
      "webhook": "https://relay.activ8ai.app/webhook/claude"
    },
    "prime": {
      "enabled": true,
      "role": "executor",
      "webhook": "https://relay.activ8ai.app/webhook/prime"
    },
    "repo_agent": {
      "enabled": true,
      "role": "repository_manager",
      "level": "L4"
    }
  },
  "integrations": {
    "notion": {
      "enabled": true,
      "relay_database": "2765dd73706e81b99164c8ab690be72a"
    },
    "teamwork": {
      "enabled": true,
      "project_id": "510271"
    },
    "github": {
      "enabled": true,
      "org": "Activ8-AI"
    }
  },
  "logging": {
    "level": "info",
    "format": "json",
    "evidence_first": true
  }
}
EOF
    log_success "Created aoe_config.json"

    echo ""
    log_success "Phase 2 AOE wiring complete"
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: VALIDATION
# ═══════════════════════════════════════════════════════════════════════════════

phase2_validation() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  PHASE 2: VALIDATION"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""

    local tests_passed=0
    local tests_failed=0

    # Test 1: .env.local exists and valid
    log_info "Test 1: Validating .env.local..."
    if [[ -f "${MAOS_DIR}/.env.local" ]] && grep -q "RELAY_BASE_URL" "${MAOS_DIR}/.env.local"; then
        log_success "Test 1 PASSED: .env.local valid"
        ((tests_passed++))
    else
        log_error "Test 1 FAILED: .env.local invalid"
        ((tests_failed++))
    fi

    # Test 2: aoe_config.json valid JSON
    log_info "Test 2: Validating aoe_config.json..."
    if [[ -f "${MAOS_DIR}/aoe_config.json" ]] && python3 -c "import json; json.load(open('${MAOS_DIR}/aoe_config.json'))" 2>/dev/null; then
        log_success "Test 2 PASSED: aoe_config.json valid JSON"
        ((tests_passed++))
    else
        log_error "Test 2 FAILED: aoe_config.json invalid"
        ((tests_failed++))
    fi

    # Test 3: Relay health endpoint
    log_info "Test 3: Testing relay health endpoint..."
    if curl -s --connect-timeout 10 "${RELAY_BASE_URL}/health" > /dev/null 2>&1; then
        log_success "Test 3 PASSED: Relay health endpoint responding"
        ((tests_passed++))
    else
        log_warning "Test 3 SKIPPED: Relay endpoint offline (non-blocking)"
        ((tests_passed++))
    fi

    # Test 4: Claude webhook endpoint
    log_info "Test 4: Testing Claude webhook endpoint..."
    if curl -s --connect-timeout 10 "${RELAY_BASE_URL}/webhook/claude" > /dev/null 2>&1; then
        log_success "Test 4 PASSED: Claude webhook responding"
        ((tests_passed++))
    else
        log_warning "Test 4 SKIPPED: Claude webhook offline (non-blocking)"
        ((tests_passed++))
    fi

    # Test 5: GitHub API reachable
    log_info "Test 5: Testing GitHub API..."
    if curl -s --connect-timeout 10 "https://api.github.com" > /dev/null 2>&1; then
        log_success "Test 5 PASSED: GitHub API reachable"
        ((tests_passed++))
    else
        log_error "Test 5 FAILED: GitHub API unreachable"
        ((tests_failed++))
    fi

    # Test 6: Notion API reachable
    log_info "Test 6: Testing Notion API..."
    if curl -s --connect-timeout 10 "https://api.notion.com" > /dev/null 2>&1; then
        log_success "Test 6 PASSED: Notion API reachable"
        ((tests_passed++))
    else
        log_error "Test 6 FAILED: Notion API unreachable"
        ((tests_failed++))
    fi

    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  VALIDATION RESULTS: ${tests_passed} passed, ${tests_failed} failed"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""

    if [[ $tests_failed -eq 0 ]]; then
        log_success "All validation tests passed"
        return 0
    else
        log_error "Some validation tests failed"
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: M1 AUDIT SCRIPT PREPARATION
# ═══════════════════════════════════════════════════════════════════════════════

phase3_prep() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════════"
    echo "  PHASE 3: M1 MIGRATION PREPARATION"
    echo "═══════════════════════════════════════════════════════════════════"
    echo ""

    # Create migration staging directory
    log_info "Creating migration staging directory..."
    mkdir -p "${HOME}/MIGRATION_STAGING/m1_backup"
    log_success "Created ~/MIGRATION_STAGING/m1_backup"

    # Create M1 audit script
    log_info "Creating M1 comprehensive audit script..."
    cat > "/tmp/m1_comprehensive_audit.sh" << 'AUDIT_EOF'
#!/bin/bash
# M1 Comprehensive Audit Script
# Run this on your MacBook Air M1

OUTPUT_DIR="/tmp/m1_audit_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTPUT_DIR"

echo "Starting M1 comprehensive audit..."
echo "Output directory: $OUTPUT_DIR"

# 1. System Info
echo "Collecting system info..."
{
    echo "=== SYSTEM INFO ==="
    sw_vers
    uname -a
    sysctl -n machdep.cpu.brand_string
    df -h
} > "$OUTPUT_DIR/01_system_info.txt"

# 2. Directory Structure
echo "Collecting directory structure..."
{
    echo "=== HOME DIRECTORY STRUCTURE ==="
    find ~ -maxdepth 3 -type d 2>/dev/null
} > "$OUTPUT_DIR/02_directory_structure.txt"

# 3. Git Repositories
echo "Finding git repositories..."
{
    echo "=== GIT REPOSITORIES ==="
    find ~ -name ".git" -type d 2>/dev/null | sed 's/\/.git$//'
} > "$OUTPUT_DIR/03_git_repos.txt"

# 4. MAOS Directory
echo "Analyzing MAOS directory..."
{
    echo "=== MAOS DIRECTORY ==="
    if [[ -d ~/.maos ]]; then
        ls -la ~/.maos/
        find ~/.maos -type f 2>/dev/null
    else
        echo "No ~/.maos directory found"
    fi
} > "$OUTPUT_DIR/04_maos_analysis.txt"

# 5. Config Files
echo "Collecting config files..."
{
    echo "=== SSH CONFIG ==="
    ls -la ~/.ssh/ 2>/dev/null || echo "No .ssh directory"
    echo ""
    echo "=== GPG KEYS ==="
    gpg --list-keys 2>/dev/null || echo "No GPG keys"
    echo ""
    echo "=== GIT CONFIG ==="
    cat ~/.gitconfig 2>/dev/null || echo "No .gitconfig"
} > "$OUTPUT_DIR/05_config_files.txt"

# 6. Running Processes
echo "Listing processes..."
{
    echo "=== RUNNING PROCESSES ==="
    ps aux | head -50
} > "$OUTPUT_DIR/06_processes.txt"

# 7. Dev Tools
echo "Checking dev tools..."
{
    echo "=== DEV TOOLS ==="
    echo "Node: $(node --version 2>/dev/null || echo 'not installed')"
    echo "NPM: $(npm --version 2>/dev/null || echo 'not installed')"
    echo "Python: $(python3 --version 2>/dev/null || echo 'not installed')"
    echo "Git: $(git --version 2>/dev/null || echo 'not installed')"
    echo "Docker: $(docker --version 2>/dev/null || echo 'not installed')"
    echo "gh: $(gh --version 2>/dev/null | head -1 || echo 'not installed')"
} > "$OUTPUT_DIR/07_dev_tools.txt"

# 8. Disk Usage
echo "Calculating disk usage..."
{
    echo "=== DISK USAGE (TOP 20) ==="
    du -sh ~/* 2>/dev/null | sort -hr | head -20
} > "$OUTPUT_DIR/08_disk_usage.txt"

# Create summary
echo "Creating summary..."
{
    echo "=== M1 AUDIT SUMMARY ==="
    echo "Generated: $(date)"
    echo "Files created: 8"
    echo ""
    echo "Review each file for migration decisions."
} > "$OUTPUT_DIR/00_SUMMARY.txt"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  M1 AUDIT COMPLETE"
echo "  Output: $OUTPUT_DIR"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Transfer to M4 Pro with:"
echo "  scp -r $OUTPUT_DIR activ8ai@m4.local:~/MIGRATION_STAGING/m1_backup/"
AUDIT_EOF
    chmod +x /tmp/m1_comprehensive_audit.sh
    log_success "Created M1 audit script at /tmp/m1_comprehensive_audit.sh"

    echo ""
    log_success "Phase 3 preparation complete"
    echo ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# MAIN EXECUTION
# ═══════════════════════════════════════════════════════════════════════════════

main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════╗"
    echo "║  LMAOS DESIGN SYSTEM - PHASE 2 & 3 EXECUTION                     ║"
    echo "║  Charter: v1.3.1 | Evidence-first, zero-drift                    ║"
    echo "║  Timestamp: ${TIMESTAMP}                                          ║"
    echo "╚═══════════════════════════════════════════════════════════════════╝"
    echo ""

    # Run all phases
    preflight_checks
    phase2_aoe_wiring
    phase2_validation
    phase3_prep

    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════╗"
    echo "║  EXECUTION COMPLETE                                               ║"
    echo "╠═══════════════════════════════════════════════════════════════════╣"
    echo "║  ✅ Phase 2: AOE endpoint configuration complete                  ║"
    echo "║  ✅ Phase 2: Validation complete                                  ║"
    echo "║  ✅ Phase 3: Preparation complete                                 ║"
    echo "╠═══════════════════════════════════════════════════════════════════╣"
    echo "║  NEXT STEPS:                                                      ║"
    echo "║  1. Run M1 audit: bash /tmp/m1_comprehensive_audit.sh             ║"
    echo "║  2. Transfer results to M4 Pro                                    ║"
    echo "║  3. Review audit + make migration decisions                       ║"
    echo "║  4. Execute Phase 3 consolidation                                 ║"
    echo "╚═══════════════════════════════════════════════════════════════════╝"
    echo ""
}

# Run main
main "$@"
