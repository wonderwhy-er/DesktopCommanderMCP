# Publishing Guide for Desktop Commander MCP

This document outlines the complete process for publishing new versions of Desktop Commander to both NPM and the MCP Registry.

## 🚀 Automated Release (Recommended)

We now have an automated release script that handles the entire process!

```bash
# Patch release (0.2.16 → 0.2.17) - Bug fixes, small improvements
npm run release

# Minor release (0.2.16 → 0.3.0) - New features
npm run release:minor

# Major release (0.2.16 → 1.0.0) - Breaking changes
npm run release:major

# Test without publishing
npm run release:dry
```

**See [scripts/README-RELEASE.md](scripts/README-RELEASE.md) for full documentation of the automated release process.**

The script automatically handles:
- ✅ Version bumping
- ✅ Building project and MCPB bundle
- ✅ Running tests
- ✅ Git commit and tagging
- ✅ NPM publishing
- ✅ MCP Registry publishing
- ✅ Publication verification

---

## Manual Release Process

If you prefer to release manually or need to troubleshoot, follow these steps:

## Prerequisites

- Node.js 18+ installed
- NPM account with publish permissions to `@wonderwhy-er/desktop-commander`
- GitHub account with access to `wonderwhy-er/DesktopCommanderMCP`
- `mcp-publisher` CLI tool installed: `brew install mcp-publisher`

## Publishing Process

### 1. Version Bump

Choose the appropriate version bump based on your changes:

```bash
# Patch version (0.2.14 → 0.2.15) - Bug fixes, small improvements
npm run bump

# Minor version (0.2.14 → 0.3.0) - New features, backwards compatible
npm run bump:minor

# Major version (0.2.14 → 1.0.0) - Breaking changes
npm run bump:major
```

This script automatically updates:
- `package.json` version
- `server.json` version and packages array
- `src/version.ts` version

### 2. Build and Test

```bash
# Build the project to ensure everything compiles
npm run build

# Run tests to ensure quality
npm test

# Optional: Test locally if needed
npm run setup:debug
```

### 3. Commit and Tag

```bash
# Stage the version files
git add package.json server.json src/version.ts

# Commit with descriptive message
git commit -m "Bump version to X.Y.Z

- Brief description of changes
- Notable features or fixes
- Any breaking changes"

# Create and push git tag
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

### 4. Publish to NPM

```bash
# Publish to NPM registry
npm publish

# Verify publication
npm view @wonderwhy-er/desktop-commander version
```

**Note**: Make sure you're logged into NPM with the correct account:
```bash
npm whoami
# If not logged in: npm login
```

### 5. Publish to MCP Registry

```bash
# Authenticate with GitHub (if token expired)
mcp-publisher login github
# Follow the device flow authentication

# Publish to MCP Registry
mcp-publisher publish

# Verify publication
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.wonderwhy-er/desktop-commander" | jq '.servers[0].version'
```

### 6. Create GitHub Release (Optional but Recommended)

1. Go to https://github.com/wonderwhy-er/DesktopCommanderMCP/releases
2. Click "Create a new release"
3. Select the tag you just created (`vX.Y.Z`)
4. Fill in release notes with:
   - **What's New**: New features and improvements
   - **Bug Fixes**: Issues resolved
   - **Breaking Changes**: If any (for major versions)
   - **Installation**: Reference to updated installation methods

## Complete Example Workflow

```bash
# 1. Bump version (patch example)
npm run bump

# 2. Build and test
npm run build
npm test

# 3. Commit and tag
git add package.json server.json src/version.ts
git commit -m "Bump version to 0.2.15

- Fixed issue with file search performance
- Added better error handling for process timeouts
- Updated documentation"

git tag v0.2.15
git push origin main
git push origin v0.2.15

# 4. Publish to NPM
npm publish

# 5. Publish to MCP Registry
mcp-publisher publish

# 6. Verify both publications
npm view @wonderwhy-er/desktop-commander version
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.wonderwhy-er/desktop-commander" | jq '.servers[0].version'
```

## Troubleshooting

### NPM Publishing Issues

- **Authentication Error**: Run `npm login` and verify with `npm whoami`
- **Permission Error**: Ensure you have publish rights to the `@wonderwhy-er` scope
- **Version Already Exists**: You cannot republish the same version. Bump the version again.

### MCP Registry Issues

- **Authentication Expired**: Run `mcp-publisher login github` and complete device flow
- **Repository URL Invalid**: Ensure the GitHub repository is public and accessible
- **Server.json Validation**: Check that the format matches the schema requirements

### Common Mistakes to Avoid

1. **Forgetting to build**: Always run `npm run build` before publishing
2. **Inconsistent versions**: Use the bump scripts to keep all files in sync
3. **Missing git tags**: Tags help track releases and are expected by many tools
4. **Not testing**: Test the build locally before publishing
5. **Publishing without committing**: Always commit version changes before publishing

## Registry Information

- **NPM Package**: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander
- **MCP Registry**: https://registry.modelcontextprotocol.io/
- **Server ID**: `490703ba-12b3-48d8-81ef-056010280a9a`
- **GitHub Repository**: https://github.com/wonderwhy-er/DesktopCommanderMCP

## Version Sync Script Details

The `scripts/sync-version.js` script ensures version consistency by:
1. Reading the version from `package.json`
2. Optionally bumping it (patch/minor/major)
3. Writing the updated version to:
   - `package.json`
   - `server.json` (both main version and packages array)
   - `src/version.ts`

This prevents version mismatches between NPM and MCP Registry publications.
