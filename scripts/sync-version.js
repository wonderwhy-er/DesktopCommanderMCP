import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

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

// The repository-root manifest is a discoverable snapshot of the latest STABLE MCPB.
// Never advertise an alpha/beta package to directory crawlers. The real bundle
// manifest is generated from the same template in scripts/build-mcpb.cjs.
const stableRelease = /^\d+\.\d+\.\d+$/.test(version);
if (stableRelease) {
    const template = readFileSync('manifest.template.json', 'utf8');
    const manifest = JSON.parse(template.replace('"{{VERSION}}"', JSON.stringify(version)));
    // This schema path is meaningful only inside the bundle build directory.
    delete manifest.$schema;
    writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
}

console.log(`Version ${version} synchronized${shouldBump ? ' and bumped' : ''} across package.json, server.json, version.ts${stableRelease ? ', and manifest.json' : ' (stable root manifest unchanged)'}`);
