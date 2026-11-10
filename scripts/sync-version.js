import { existsSync, readFileSync, writeFileSync } from 'fs';
import releaseVersion from './release-version.cjs';

const { nextStableVersion } = releaseVersion;

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
    version = nextStableVersion(version, bumpType);
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

// npm ci uses this lockfile on the next checkout, and release tags should
// describe a single version across every tracked package metadata file.
if (existsSync('package-lock.json')) {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}

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
