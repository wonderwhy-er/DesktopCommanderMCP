# Docker MCP Configuration Guide

This document explains how to properly configure Desktop Commander with Docker MCP Gateway to ensure filesystem persistence and avoid the ephemeral container bug.

## Quick Fix

If you're experiencing the persistence bug where files written with `write_file` disappear on subsequent operations, use this immediate workaround:

```bash
# Run MCP Gateway in long-lived mode
docker mcp gateway run --long-lived
```

## The Problem

Desktop Commander was losing filesystem state between tool calls because Docker MCP Gateway was creating fresh containers for each operation instead of maintaining a persistent container.

## Root Cause

The Docker MCP Gateway supports two execution modes:

### 1. Ephemeral Tools (PROBLEMATIC)
```yaml
registry:
  desktop-commander-tools:
    tools:
      - name: write_file
        container:
          image: "mcp/desktop-commander:latest"
          command: ["write_file_tool"]  # Fresh container per call
      - name: read_file  
        container:
          image: "mcp/desktop-commander:latest"
          command: ["read_file_tool"]   # Fresh container per call
```

**Result**: Each tool call creates a new container with `--rm` flag, losing all filesystem state.

### 2. Persistent MCP Server (CORRECT)
```yaml
registry:
  desktop-commander:
    image: "mcp/desktop-commander:latest"
    longLived: true  # CRITICAL: Maintains container across calls
    command: ["node", "dist/index.js"]
```

**Result**: Single long-lived container maintains filesystem state across all tool calls.

## Correct Configuration

### For Docker MCP Catalog Maintainers

Update the Desktop Commander entry in the official Docker MCP catalog:

```yaml
registry:
  desktop-commander:
    # Container image
    image: "mcp/desktop-commander:latest"
    
    # CRITICAL: Enable persistent container mode
    longLived: true
    
    # Environment variables
    env:
      - name: "MCP_CLIENT_DOCKER"
        value: "true"
      - name: "NODE_ENV"
        value: "production"
    
    # Command to run the MCP server
    command: ["node", "dist/index.js"]
    
    # Optional: Volume mounts for development workflows
    volumes:
      - "./workspace:/workspace"  # Persistent workspace
    
    # Security settings
    disableNetwork: false
```

### For Advanced Users

Create a custom catalog file (`my-catalog.yaml`):

```yaml
registry:
  desktop-commander:
    image: "mcp/desktop-commander:latest"
    longLived: true
    env:
      - name: "MCP_CLIENT_DOCKER"
        value: "true"
    command: ["node", "dist/index.js"]
```

Then run with custom catalog:
```bash
docker mcp gateway run --catalog ./my-catalog.yaml
```

### For Development Workflows

For persistent development environments, add volume mounts:

```yaml
registry:
  desktop-commander:
    image: "mcp/desktop-commander:latest"
    longLived: true
    volumes:
      - "./project:/workspace"
      - "~/.desktop-commander:/app/config"
    env:
      - name: "MCP_CLIENT_DOCKER"
        value: "true"
      - name: "WORKSPACE_DIR"
        value: "/workspace"
```

## Workarounds

### 1. Global Long-Lived Mode (Immediate)
```bash
docker mcp gateway run --long-lived
```

This forces ALL MCP servers to use persistent containers.

### 2. Custom Configuration (Advanced)
```bash
# Create custom catalog
echo 'registry:
  desktop-commander:
    image: "mcp/desktop-commander:latest"
    longLived: true
    command: ["node", "dist/index.js"]' > custom-catalog.yaml

# Run with custom catalog
docker mcp gateway run --catalog ./custom-catalog.yaml
```

### 3. Standalone Docker (Bypass Gateway)
```json
{
  "mcpServers": {
    "desktop-commander": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "mcp/desktop-commander:latest"
      ]
    }
  }
}
```

Note: This bypasses the MCP Gateway entirely but loses other benefits.

## Testing the Fix

After applying the configuration:

1. **Write a file**:
   ```
   write_file("/tmp/test.txt", "Hello World")
   ```

2. **List directory**:
   ```
   list_directory("/tmp")
   ```
   Should show `test.txt`

3. **Read the file**:
   ```
   read_file("/tmp/test.txt")
   ```
   Should return "Hello World"

4. **Append to file**:
   ```
   write_file("/tmp/test.txt", "\nSecond line", {mode: "append"})
   ```

5. **Read again**:
   ```
   read_file("/tmp/test.txt")
   ```
   Should return both lines

## Technical Details

The issue occurs in these Docker MCP Gateway code paths:

- **Ephemeral execution**: `mcpToolHandler()` → `runToolContainer()` → Fresh container with `--rm`
- **Persistent execution**: `mcpServerToolHandler()` → `AcquireClient()` → Reused container

The `longLived: true` setting forces the gateway to use the persistent execution path.

## Environment Variables

Key environment variables for Desktop Commander in Docker:

- `MCP_CLIENT_DOCKER=true` - Indicates running in Docker environment
- `NODE_ENV=production` - Production mode optimizations
- `WORKSPACE_DIR=/workspace` - Optional workspace directory

## Security Considerations

Persistent containers maintain state, which includes:
- ✅ **Benefits**: Installed packages, configuration files, working directories
- ⚠️  **Considerations**: Accumulated data, temporary files, potential secrets

For production deployments, consider:
- Regular container restarts
- Volume mounts for important data only
- Proper secret management
- Resource limits

## Troubleshooting

### Files Still Disappearing?

1. **Check MCP Gateway logs**:
   ```bash
   docker mcp gateway run --verbose
   ```

2. **Verify configuration**:
   ```bash
   docker mcp server inspect desktop-commander
   ```

3. **Check container persistence**:
   ```bash
   docker ps  # Should show long-running desktop-commander container
   ```

### Performance Issues?

1. **Monitor resource usage**:
   ```bash
   docker stats
   ```

2. **Set resource limits**:
   ```yaml
   registry:
     desktop-commander:
       image: "mcp/desktop-commander:latest"
       longLived: true
       resources:
         memory: "512m"
         cpus: "1.0"
   ```

## Related Issues

- [MCP Gateway Issue #XXX](https://github.com/docker/mcp-gateway/issues/XXX) - Persistence bug report
- [Desktop Commander Issue #XXX](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/XXX) - User reports

## Contributing

If you encounter issues with this configuration:

1. Test the workarounds above
2. Check Docker MCP Gateway logs
3. Report issues with specific configuration details
4. Include `docker version` and `docker mcp version` output
