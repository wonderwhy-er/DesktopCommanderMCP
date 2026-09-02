import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const PACKAGE_NAME = '@wonderwhy-er/desktop-commander';

// Plugin manifests pin the npm version in their MCP launch args, so they have
// to move with every release. They cannot use `@latest`: npx re-resolves that
// on every launch and reinstalls the whole dependency tree whenever the cached
// copy is stale, which can outlast a host's connect timeout on a slow machine.
const PLUGIN_MANIFESTS = [
    'plugins/claude/.claude-plugin/plugin.json',
    'plugins/cursor/.cursor-plugin/plugin.json'
];

function bumpVersion(version, type = 'patch') {
    const [major, minor, patch] = version.split('.').map(Number);
    switch(type) {
        case 'major':
            return `${major + 1}.0.0`;
        case 'minor':
            return `${major}.${minor + 1}.0`;
        case 'patch':
        default:
            return `${major}.${minor}.${patch + 1}`;
    }
}

// Read command line arguments
const shouldBump = process.argv.includes('--bump');
const bumpType = process.argv.includes('--major') ? 'major' 
               : process.argv.includes('--minor') ? 'minor' 
               : 'patch';

// Read version from package.json
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let version = pkg.version;

// Bump version if requested
if (shouldBump) {
    version = bumpVersion(version, bumpType);
    // Update package.json
    pkg.version = version;
    writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}

// Update server.json
const serverJson = JSON.parse(readFileSync('server.json', 'utf8'));
serverJson.version = version;
// Also update the package version in the packages array
if (serverJson.packages && serverJson.packages.length > 0) {
    serverJson.packages.forEach(pkg => {
        if (pkg.registryType === 'npm' && pkg.identifier === '@wonderwhy-er/desktop-commander') {
            pkg.version = version;
        }
    });
}
writeFileSync('server.json', JSON.stringify(serverJson, null, 2) + '\n');

// Update version.ts
const versionFileContent = `export const VERSION = '${version}';\n`;
writeFileSync('src/version.ts', versionFileContent);

// Update the pinned launch version in each plugin manifest
const updatedManifests = [];
PLUGIN_MANIFESTS.forEach(manifestPath => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const server = manifest.mcpServers && manifest.mcpServers['desktop-commander'];
    if (!server || !Array.isArray(server.args)) {
        console.warn(`Skipped ${manifestPath}: no desktop-commander mcpServers args to update`);
        return;
    }
    server.args = server.args.map(arg =>
        typeof arg === 'string' && arg.startsWith(`${PACKAGE_NAME}@`)
            ? `${PACKAGE_NAME}@${version}`
            : arg
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    updatedManifests.push(manifestPath);
});

const targets = ['package.json', 'server.json', 'version.ts', ...updatedManifests].join(', ');
console.log(`Version ${version} synchronized${shouldBump ? ' and bumped' : ''} across ${targets}`);
