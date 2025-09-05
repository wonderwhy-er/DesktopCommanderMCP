# Desktop Commander MCP - Development Commands

## Essential Commands

### Build & Development
```bash
npm run build          # Compile TypeScript to dist/
npm run watch          # Watch mode for development
npm run start          # Run the compiled server
npm run start:debug    # Run with Node.js debugger
npm run clean          # Remove dist/ directory
```

### Setup & Installation
```bash
npm run setup          # Build and configure Claude Desktop
npm run setup:debug    # Setup with debug mode enabled
npm run remove         # Uninstall from Claude Desktop
```

### Testing
```bash
npm run test           # Run all tests
npm run test:debug     # Run tests with debugger
```

### MCP Inspector
```bash
npm run inspector      # Launch MCP inspector tool
```

### Fuzzy Search Logs
```bash
npm run logs:view      # View recent fuzzy search logs
npm run logs:analyze   # Analyze log patterns
npm run logs:clear     # Clear all logs
npm run logs:export    # Export logs to CSV/JSON
```

### Version Management
```bash
npm run sync-version   # Sync versions across files
npm run bump           # Bump patch version
npm run bump:minor     # Bump minor version
npm run bump:major     # Bump major version
```

## System-Specific Commands (Darwin/macOS)
- `find`: Use for file searching
- `grep`: Text pattern searching
- `ls`: Directory listing
- `cd`: Directory navigation
- `git`: Version control operations
- `killall`: Process termination
- `open`: Application launching
