# Changelog

## [0.2.7] - 2025-07-19

### Fixed
- **Major**: Fixed filesystem persistence bug when using Docker MCP Gateway
  - Added proper configuration for persistent container mode
  - Desktop Commander now maintains filesystem state across tool calls
  - Eliminates false success reports from `write_file` operations

### Added
- Docker MCP Gateway configuration file (`docker-mcp.yaml`)
- Comprehensive Docker MCP configuration guide (`docs/DOCKER_MCP_CONFIGURATION.md`)
- Persistence detection utilities to identify ephemeral container issues
- Automatic warnings when running in ephemeral mode
- Configuration recommendations for Docker MCP Gateway users

### Changed
- Enhanced `get_config` command to include Docker MCP persistence status
- Added detection for Docker MCP Gateway environment variables
- Improved container lifecycle awareness

### Documentation
- Added `DOCKER_MCP_FIX.md` with detailed root cause analysis
- Created configuration guide for proper Docker MCP setup
- Documented workarounds for immediate persistence fixes

### Technical Details
- Root cause: Desktop Commander was configured as ephemeral tools instead of persistent MCP server
- Solution: Added `longLived: true` to Docker MCP catalog configuration
- Impact: Fixes filesystem persistence, eliminates false success reports, enables proper development workflows

## [0.2.6] - Previous release
- Previous features and fixes...
