# Fix for MCP Gateway Persistence Bug

## Problem

Desktop Commander was experiencing filesystem persistence issues when used with Docker MCP Gateway. Files written with `write_file` would appear to succeed but disappear on subsequent operations.

## Root Cause

The Docker MCP Gateway has two execution modes:
1. **Ephemeral containers** - Fresh container per tool call (causes persistence loss)
2. **Persistent MCP servers** - Long-lived containers (maintains filesystem state)

Desktop Commander was configured as ephemeral standalone tools instead of a persistent MCP server.

## Solution

This fix provides the correct configuration for Desktop Commander in the Docker MCP catalog:

### Key Changes

1. **Added `longLived: true`** - This is the critical setting that prevents ephemeral container creation
2. **Configured as MCP server** - Rather than individual tool containers
3. **Proper environment variables** - Including `MCP_CLIENT_DOCKER=true`
4. **Optional volume mounts** - For development workflows requiring persistent workspaces

### Files Added

- `docker-mcp.yaml` - Correct catalog configuration for persistent mode
- `docs/DOCKER_MCP_CONFIGURATION.md` - Detailed configuration guide

### Usage

For Docker MCP catalog maintainers:
```yaml
registry:
  desktop-commander:
    image: "mcp/desktop-commander:latest"
    longLived: true  # CRITICAL FIX
    env:
      - name: "MCP_CLIENT_DOCKER"
        value: "true"
    command: ["node", "dist/index.js"]
```

For users experiencing the bug:
```bash
# Workaround: Use global long-lived mode
docker mcp gateway run --long-lived

# Or create custom catalog with correct configuration
docker mcp gateway run --catalog ./docker-mcp.yaml
```

### Impact

- ✅ Fixes filesystem persistence across tool calls
- ✅ Maintains container state between operations  
- ✅ Eliminates false success reports from `write_file`
- ✅ Enables proper development workflows

### Testing

After applying this fix:
1. Write a file using `write_file`
2. List directory using `list_directory` 
3. Read the file using `read_file`
4. All operations should see the same persistent filesystem

## Background

This issue was discovered through detailed analysis of the Docker MCP Gateway source code, specifically:
- `/cmd/docker-mcp/internal/gateway/clientpool.go` - Container lifecycle management
- `/cmd/docker-mcp/internal/gateway/handlers.go` - Tool vs server routing
- `/cmd/docker-mcp/internal/catalog/types.go` - Configuration structure

The fix aligns Desktop Commander with the intended persistent server architecture rather than the ephemeral tool model.
