#!/usr/bin/env node

/**
 * Desktop Commander - Complete Release Publishing Script with State Tracking
 * 
 * This script handles the entire release process:
 * 1. Version bump
 * 2. Build project and MCPB bundle
 * 3. Commit and tag
 * 4. Publish to NPM
 * 5. Publish to MCP Registry
 * 6. Verify publications
 * 
 * Features automatic resume from failed steps and state tracking.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// State file path
const STATE_FILE = path.join(process.cwd(), '.release-state.json');

// Colors for output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

// Helper functions for colored output
function printStep(message) {
    console.log(`${colors.blue}==>${colors.reset} ${message}`);
}

function printSuccess(message) {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function printError(message) {
    console.error(`${colors.red}✗${colors.reset} ${message}`);
}

function printWarning(message) {
    console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function printInfo(message) {
    console.log(`${colors.cyan}ℹ${colors.reset} ${message}`);
}

// State management functions
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        } catch (error) {
            printWarning('Could not parse state file, starting fresh');
            return null;
        }
    }
    return null;
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function clearState() {
    if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
        printSuccess('Release state cleared');
    } else {
        printInfo('No release state to clear');
    }
}

function markStepComplete(state, step) {
    state.completedSteps.push(step);
    state.lastStep = step;
    saveState(state);
}

function isStepComplete(state, step) {
    return state && state.completedSteps.includes(step);
}

// Execute command with error handling
function exec(command, options = {}) {
    try {
        return execSync(command, { 
            encoding: 'utf8', 
            stdio: options.silent ? 'pipe' : 'inherit',
            ...options 
        });
    } catch (error) {
        if (options.ignoreError) {
            return options.silent ? '' : null;
        }
        throw error;
    }
}

// Execute command silently and return output
function execSilent(command, options = {}) {
    return exec(command, { silent: true, ...options });
}

/**
 * Calculate alpha version from current version
 * - "0.2.28" → "0.2.29-alpha.0"
 * - "0.2.29-alpha.0" → "0.2.29-alpha.1"
 * - "0.2.29-alpha.5" → "0.2.29-alpha.6"
 */
function getAlphaVersion(currentVersion) {
    const alphaMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-alpha\.(\d+)$/);
    
    if (alphaMatch) {
        // Already an alpha, increment the alpha number
        const baseVersion = alphaMatch[1];
        const alphaNum = parseInt(alphaMatch[2], 10) + 1;
        return `${baseVersion}-alpha.${alphaNum}`;
    } else {
        // Regular version, bump patch and add -alpha.0
        const [major, minor, patch] = currentVersion.split('.').map(Number);
        return `${major}.${minor}.${patch + 1}-alpha.0`;
    }
}

/**
 * Update version in package.json, server.json, and version.ts
 */
function updateVersionFiles(newVersion) {
    // Update package.json
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    
    // Update server.json
    const serverJsonPath = path.join(process.cwd(), 'server.json');
    const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
    serverJson.version = newVersion;
    if (serverJson.packages && serverJson.packages.length > 0) {
        serverJson.packages.forEach(p => {
            if (p.registryType === 'npm' && p.identifier === '@wonderwhy-er/desktop-commander') {
                p.version = newVersion;
            }
        });
    }
    fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n');
    
    // Update version.ts
    const versionTsPath = path.join(process.cwd(), 'src', 'version.ts');
    fs.writeFileSync(versionTsPath, `export const VERSION = '${newVersion}';\n`);
}

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        bumpType: 'patch',
        skipTests: false,
        dryRun: false,
        help: false,
        clearState: false,
        skipBump: false,
        skipBuild: false,
        skipMcpb: false,
        skipGit: false,
        skipNpm: false,
        skipMcp: false,
        alpha: false,
    };

    for (const arg of args) {
        switch (arg) {
            case '--minor':
                options.bumpType = 'minor';
                break;
            case '--major':
                options.bumpType = 'major';
                break;
            case '--skip-tests':
                options.skipTests = true;
                break;
            case '--skip-bump':
                options.skipBump = true;
                break;
            case '--skip-build':
                options.skipBuild = true;
                break;
            case '--skip-mcpb':
                options.skipMcpb = true;
                break;
            case '--skip-git':
                options.skipGit = true;
                break;
            case '--skip-npm':
                options.skipNpm = true;
                break;
            case '--skip-mcp':
                options.skipMcp = true;
                break;
            case '--npm-only':
                // Skip everything except NPM publish
                options.skipMcpb = true;
                options.skipGit = true;
                options.skipMcp = true;
                break;
            case '--alpha':
                options.alpha = true;
                break;
            case '--mcp-only':
                // Skip everything except MCP Registry publish
                options.skipBump = true;
                options.skipBuild = true;
                options.skipMcpb = true;
                options.skipGit = true;
                options.skipNpm = true;
                break;
            case '--clear-state':
                options.clearState = true;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                printError(`Unknown option: ${arg}`);
                console.log("Run 'node scripts/publish-release.cjs --help' for usage information.");
                process.exit(1);
        }
    }

    return options;
}

// Show help message
function showHelp() {
    console.log('Usage: node scripts/publish-release.cjs [OPTIONS]');
    console.log('');
    console.log('Options:');
    console.log('  --minor         Bump minor version (default: patch)');
    console.log('  --major         Bump major version (default: patch)');
    console.log('  --skip-tests    Skip running tests');
    console.log('  --skip-bump     Skip version bumping');
    console.log('  --skip-build    Skip building (if tests also skipped)');
    console.log('  --skip-mcpb     Skip building MCPB bundle');
    console.log('  --skip-git      Skip git commit and tag');
    console.log('  --skip-npm      Skip NPM publishing');
    console.log('  --skip-mcp      Skip MCP Registry publishing');
    console.log('  --npm-only      Only publish to NPM (skip MCPB, git, MCP Registry)');
    console.log('  --alpha         Publish as alpha version (e.g., 0.2.29-alpha.0)');
    console.log('  --mcp-only      Only publish to MCP Registry (skip all other steps)');
    console.log('  --clear-state   Clear release state and start fresh');
    console.log('  --dry-run       Simulate the release without publishing');
    console.log('  --help, -h      Show this help message');
    console.log('');
    console.log('State Management:');
    console.log('  The script automatically tracks completed steps and resumes from failures.');
    console.log('  Use --clear-state to reset and start from the beginning.');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/publish-release.cjs              # Patch release (0.2.16 -> 0.2.17)');
    console.log('  node scripts/publish-release.cjs --minor      # Minor release (0.2.16 -> 0.3.0)');
    console.log('  node scripts/publish-release.cjs --major      # Major release (0.2.16 -> 1.0.0)');
    console.log('  node scripts/publish-release.cjs --dry-run    # Test without publishing');
    console.log('  node scripts/publish-release.cjs --mcp-only   # Only publish to MCP Registry');
    console.log('  node scripts/publish-release.cjs --npm-only --alpha  # Alpha release to NPM only');
    console.log('  node scripts/publish-release.cjs --clear-state # Reset state and start over');
}

// =============================================================================
// PRE-FLIGHT CHECKS - Run before any publishing to catch issues early
// =============================================================================

/**
 * Check if mcp-publisher is installed and check for updates
 */
function checkMcpPublisher() {
    printInfo('Checking mcp-publisher...');
    
    const mcpPublisherPath = execSilent('which mcp-publisher', { ignoreError: true }).trim();
    if (!mcpPublisherPath) {
        printError('mcp-publisher not found. Install it with: brew install mcp-publisher');
        return false;
    }
    
    // Get current version (output goes to stderr with timestamp prefix)
    const versionOutput = execSilent('mcp-publisher --version 2>&1', { ignoreError: true });
    const versionMatch = versionOutput.match(/mcp-publisher\s+(\d+\.\d+\.\d+)/);
    const currentVersion = versionMatch ? versionMatch[1] : 'unknown';
    printSuccess(`mcp-publisher found: v${currentVersion}`);
    
    // Check for updates via brew
    try {
        const brewInfo = execSilent('brew info --json=v2 mcp-publisher 2>/dev/null', { ignoreError: true });
        if (brewInfo) {
            const info = JSON.parse(brewInfo);
            const latestVersion = info.formulae?.[0]?.versions?.stable;
            if (latestVersion && latestVersion !== currentVersion && currentVersion !== 'unknown') {
                printWarning(`mcp-publisher update available: v${currentVersion} → v${latestVersion}`);
                printWarning('Run: brew upgrade mcp-publisher');
            }
        }
    } catch (e) {
        // Ignore errors checking for updates
    }
    
    return true;
}

/**
 * Get the latest schema version from mcp-publisher
 */
function getLatestSchemaVersion() {
    // Create a temp file to get the schema version mcp-publisher uses
    const tempDir = execSilent('mktemp -d', { ignoreError: true }).trim();
    if (!tempDir) return null;
    
    try {
        execSilent(`cd ${tempDir} && mcp-publisher init 2>/dev/null`, { ignoreError: true });
        const tempServerJson = path.join(tempDir, 'server.json');
        if (fs.existsSync(tempServerJson)) {
            const content = JSON.parse(fs.readFileSync(tempServerJson, 'utf8'));
            execSilent(`rm -rf ${tempDir}`, { ignoreError: true });
            return content.$schema;
        }
    } catch (e) {
        // Ignore errors
    }
    
    execSilent(`rm -rf ${tempDir}`, { ignoreError: true });
    return null;
}

/**
 * Update server.json schema version if needed
 */
function updateServerJsonSchema() {
    const serverJsonPath = path.join(process.cwd(), 'server.json');
    if (!fs.existsSync(serverJsonPath)) {
        printError('server.json not found');
        return false;
    }
    
    const serverJson = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
    const currentSchema = serverJson.$schema;
    
    printInfo('Checking server.json schema version...');
    
    // Get latest schema from mcp-publisher
    const latestSchema = getLatestSchemaVersion();
    
    if (latestSchema && currentSchema !== latestSchema) {
        printWarning(`Updating server.json schema:`);
        printWarning(`  Old: ${currentSchema}`);
        printWarning(`  New: ${latestSchema}`);
        serverJson.$schema = latestSchema;
        fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n');
        printSuccess('server.json schema updated');
        return true; // Schema was updated
    }
    
    printSuccess(`server.json schema is current`);
    return false; // No update needed
}

/**
 * Validate server.json using mcp-publisher
 */
function validateServerJson() {
    printInfo('Validating server.json...');
    
    try {
        const result = execSilent('mcp-publisher validate 2>&1', { ignoreError: true });
        
        // Check for errors in output
        if (result.toLowerCase().includes('error') || 
            result.toLowerCase().includes('failed') ||
            result.toLowerCase().includes('invalid')) {
            printError('server.json validation failed:');
            console.log(result);
            return false;
        }
        
        printSuccess('server.json validation passed');
        return true;
    } catch (error) {
        printError('Failed to validate server.json');
        return false;
    }
}

/**
 * Check MCP Registry authentication and token expiration
 */
function checkMcpAuth() {
    printInfo('Checking MCP Registry authentication...');
    
    // First check if we can validate locally
    const validateResult = execSilent('mcp-publisher validate 2>&1', { ignoreError: true });
    
    // If validation mentions auth issues, warn about it
    if (validateResult.toLowerCase().includes('unauthorized') || 
        validateResult.toLowerCase().includes('not logged in') ||
        validateResult.toLowerCase().includes('authentication')) {
        printWarning('MCP Registry authentication may be required.');
        printWarning('If publish fails, run: mcp-publisher login github');
        return false;
    }
    
    printSuccess('Local validation passed');
    return true;
}

/**
 * Check if MCP Registry JWT token is valid and not expired
 * Makes a lightweight API call to verify the token works
 */
function checkMcpTokenExpiration() {
    printInfo('Checking MCP Registry token validity...');
    
    try {
        // mcp-publisher stores token in ~/.mcp_publisher_token
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const tokenPath = path.join(homeDir, '.mcp_publisher_token');
        
        if (!fs.existsSync(tokenPath)) {
            printError('MCP Registry token not found. Please run: mcp-publisher login github');
            return false;
        }
        
        const authData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        const token = authData.token;
        
        if (!token) {
            printError('No token found in auth file. Run: mcp-publisher login github');
            return false;
        }
        
        // Decode JWT to check expiration (JWT format: header.payload.signature)
        const parts = token.split('.');
        if (parts.length !== 3) {
            printWarning('Invalid token format. Run: mcp-publisher login github');
            return false;
        }
        
        // Decode the payload (second part) - handle base64url encoding
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
        
        if (payload.exp) {
            const expirationDate = new Date(payload.exp * 1000);
            const now = new Date();
            const hoursUntilExpiry = (expirationDate - now) / (1000 * 60 * 60);
            
            if (expirationDate <= now) {
                printError(`MCP Registry token expired on ${expirationDate.toLocaleString()}`);
                printError('Please refresh your token: mcp-publisher login github');
                return false;
            }
            
            if (hoursUntilExpiry < 1) {
                printWarning(`MCP Registry token expires in ${Math.round(hoursUntilExpiry * 60)} minutes`);
                printWarning('Consider refreshing: mcp-publisher login github');
            } else if (hoursUntilExpiry < 24) {
                printWarning(`MCP Registry token expires in ${Math.round(hoursUntilExpiry)} hours`);
            }
            
            printSuccess(`MCP Registry token valid until ${expirationDate.toLocaleString()}`);
            return true;
        }
        
        // No expiration in token - assume it's valid
        printSuccess('MCP Registry token found (no expiration set)');
        return true;
        
    } catch (error) {
        printWarning(`Could not check token: ${error.message}`);
        printWarning('Publish may fail if token is expired. If so, run: mcp-publisher login github');
        return true; // Don't block, just warn
    }
}

/**
 * Run all pre-flight checks
 * Returns true if all critical checks pass
 */
function runPreFlightChecks(options) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              🔍 PRE-FLIGHT CHECKS                        ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    
    let allPassed = true;
    let schemaUpdated = false;
    
    // Check mcp-publisher installation and version (skip if not publishing to MCP)
    if (!options.skipMcp) {
        if (!checkMcpPublisher()) {
            allPassed = false;
        }
        
        // Update schema if needed
        if (allPassed) {
            schemaUpdated = updateServerJsonSchema();
        }
        
        // Validate server.json
        if (allPassed && !validateServerJson()) {
            allPassed = false;
        }
        
        // Check MCP auth and token expiration
        if (allPassed) {
            checkMcpAuth();
            if (!checkMcpTokenExpiration()) {
                allPassed = false;
            }
        }
    } else {
        printInfo('Skipping MCP Registry checks (--skip-mcp or --npm-only)');
    }
    
    // Check NPM auth
    if (allPassed && !options.skipNpm) {
        printInfo('Checking NPM authentication...');
        const npmUser = execSilent('npm whoami 2>/dev/null', { ignoreError: true }).trim();
        if (!npmUser) {
            printError('Not logged into NPM. Please run: npm login');
            allPassed = false;
        } else {
            printSuccess(`NPM authenticated as: ${npmUser}`);
        }
    }
    
    console.log('');
    
    if (allPassed) {
        printSuccess('All pre-flight checks passed!');
        if (schemaUpdated) {
            printWarning('Note: server.json schema was updated - this will be included in the release commit');
        }
    } else {
        printError('Pre-flight checks failed. Please fix the issues above before releasing.');
    }
    
    console.log('');
    
    return allPassed;
}

// Main release function
async function publishRelease() {
    const options = parseArgs();

    if (options.help) {
        showHelp();
        return;
    }

    // Handle clear state command
    if (options.clearState) {
        clearState();
        return;
    }

    // Check if we're in the right directory
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        printError('package.json not found. Please run this script from the project root.');
        process.exit(1);
    }

    // Run pre-flight checks before anything else (unless resuming)
    const existingState = loadState();
    if (!existingState) {
        if (!runPreFlightChecks(options)) {
            process.exit(1);
        }
    }

    // Load or create state
    let state = loadState();
    const isResume = state !== null;
    
    if (!state) {
        state = {
            startTime: new Date().toISOString(),
            completedSteps: [],
            lastStep: null,
            version: null,
            bumpType: options.bumpType,
        };
    }

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║         Desktop Commander Release Publisher             ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // Show resume information
    if (isResume) {
        console.log(`${colors.cyan}╔══════════════════════════════════════════════════════════╗${colors.reset}`);
        console.log(`${colors.cyan}║              📋 RESUMING FROM PREVIOUS RUN              ║${colors.reset}`);
        console.log(`${colors.cyan}╚══════════════════════════════════════════════════════════╝${colors.reset}`);
        console.log('');
        printInfo(`Started: ${state.startTime}`);
        printInfo(`Last completed step: ${state.lastStep || 'none'}`);
        printInfo(`Completed steps: ${state.completedSteps.join(', ') || 'none'}`);
        if (state.version) {
            printInfo(`Target version: ${state.version}`);
        }
        console.log('');
        printWarning('Will skip already completed steps automatically');
        printInfo('Use --clear-state to start fresh');
        console.log('');
    }

    // Get current version
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const currentVersion = packageJson.version;
    printStep(`Current version: ${currentVersion}`);
    
    if (!isResume) {
        printStep(`Bump type: ${options.alpha ? 'alpha' : options.bumpType}`);
    }

    if (options.alpha) {
        printWarning('ALPHA MODE - Will publish with alpha tag');
    }

    if (options.dryRun) {
        printWarning('DRY RUN MODE - No changes will be published');
        console.log('');
    }

    try {
        let newVersion = state.version || currentVersion;
        
        // Step 1: Bump version
        const shouldSkipBump = options.skipBump || isStepComplete(state, 'bump');
        if (!shouldSkipBump) {
            printStep('Step 1/6: Bumping version...');
            
            if (options.alpha) {
                // Alpha version: calculate and update directly
                newVersion = getAlphaVersion(currentVersion);
                updateVersionFiles(newVersion);
            } else {
                // Guard: fail fast if current version is alpha but --alpha flag not provided
                if (currentVersion.includes('-alpha')) {
                    printError(`Current version "${currentVersion}" is an alpha version.`);
                    printError('Use --alpha for alpha releases, or manually set a stable version in package.json first.');
                    process.exit(1);
                }
                // Regular version: use npm run bump
                const bumpCommand = options.bumpType === 'minor' ? 'npm run bump:minor' :
                                   options.bumpType === 'major' ? 'npm run bump:major' :
                                   'npm run bump';
                exec(bumpCommand);
                const newPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                newVersion = newPackageJson.version;
            }

            state.version = newVersion;
            markStepComplete(state, 'bump');
            printSuccess(`Version bumped: ${currentVersion} → ${newVersion}`);
        } else if (isStepComplete(state, 'bump')) {
            printInfo('Step 1/6: Version bump already completed ✓');
        } else {
            printWarning('Step 1/6: Version bump skipped (manual override)');
        }
        console.log('');

        // Step 2: Run tests or build
        const shouldSkipBuild = options.skipBuild || isStepComplete(state, 'build');
        if (!shouldSkipBuild) {
            if (!options.skipTests) {
                printStep('Step 2/6: Running tests (includes build)...');
                exec('npm test');
                printSuccess('All tests passed');
            } else {
                printStep('Step 2/6: Building project...');
                exec('npm run build');
                printSuccess('Project built successfully');
            }
            markStepComplete(state, 'build');
        } else if (isStepComplete(state, 'build')) {
            printInfo('Step 2/6: Build already completed ✓');
        } else {
            printWarning('Step 2/6: Build skipped (manual override)');
        }
        console.log('');

        // Step 3: Build MCPB bundle
        const shouldSkipMcpb = options.skipMcpb || isStepComplete(state, 'mcpb');
        if (!shouldSkipMcpb) {
            printStep('Step 3/6: Building MCPB bundle...');
            exec('npm run build:mcpb');
            markStepComplete(state, 'mcpb');
            printSuccess('MCPB bundle created');
        } else if (isStepComplete(state, 'mcpb')) {
            printInfo('Step 3/6: MCPB bundle already created ✓');
        } else {
            printWarning('Step 3/6: MCPB bundle build skipped (manual override)');
        }
        console.log('');

        // Step 4: Commit and tag
        const shouldSkipGit = options.skipGit || isStepComplete(state, 'git');
        if (!shouldSkipGit) {
            printStep('Step 4/6: Creating git commit and tag...');
        
            // Check if there are changes to commit
            const gitStatus = execSilent('git status --porcelain', { ignoreError: true });
            const hasChanges = gitStatus.includes('package.json') || 
                              gitStatus.includes('server.json') || 
                              gitStatus.includes('src/version.ts');

            if (!hasChanges) {
                printWarning('No changes to commit (version files already committed)');
            } else {
                exec('git add package.json server.json src/version.ts');
                
                const commitMsg = `Release v${newVersion}

Automated release commit with version bump from ${currentVersion} to ${newVersion}`;

                if (options.dryRun) {
                    printWarning(`Would commit: ${commitMsg.split('\n')[0]}`);
                } else {
                    exec(`git commit -m "${commitMsg}"`);
                    printSuccess('Changes committed');
                }
            }

            // Create and push tag
            const tagName = `v${newVersion}`;
            
            if (options.dryRun) {
                printWarning(`Would create tag: ${tagName}`);
                printWarning(`Would push to origin: main and ${tagName}`);
            } else {
                // Check if tag already exists locally
                const existingTag = execSilent(`git tag -l "${tagName}"`, { ignoreError: true }).trim();
                if (existingTag === tagName) {
                    printWarning(`Tag ${tagName} already exists locally`);
                } else {
                    exec(`git tag ${tagName}`);
                    printSuccess(`Tag ${tagName} created`);
                }
                
                // Push main (ignore error if already up to date)
                exec('git push origin main', { ignoreError: true });
                
                // Push tag (check if already on remote first)
                const remoteTag = execSilent(`git ls-remote --tags origin refs/tags/${tagName}`, { ignoreError: true }).trim();
                if (remoteTag) {
                    printWarning(`Tag ${tagName} already exists on remote`);
                } else {
                    exec(`git push origin ${tagName}`);
                    printSuccess(`Tag ${tagName} pushed to remote`);
                }
            }
            
            markStepComplete(state, 'git');
        } else if (isStepComplete(state, 'git')) {
            printInfo('Step 4/6: Git commit and tag already completed ✓');
        } else {
            printWarning('Step 4/6: Git commit and tag skipped (manual override)');
        }
        console.log('');

        // Step 5: Publish to NPM
        const shouldSkipNpm = options.skipNpm || isStepComplete(state, 'npm');
        if (!shouldSkipNpm) {
            printStep('Step 5/6: Publishing to NPM...');
            
            // Check NPM authentication
            const npmUser = execSilent('npm whoami', { ignoreError: true }).trim();
            if (!npmUser) {
                printError('Not logged into NPM. Please run "npm login" first.');
                printError('After logging in, run the script again to resume from this step.');
                process.exit(1);
            }
            printSuccess(`NPM user: ${npmUser}`);

            if (options.dryRun) {
                const publishCmd = options.alpha ? 'npm publish --tag alpha' : 'npm publish';
                printWarning(`Would publish to NPM: ${publishCmd}`);
                printWarning('Skipping NPM publish (dry run)');
            } else {
                const publishCmd = options.alpha ? 'npm publish --tag alpha' : 'npm publish';
                exec(publishCmd);
                markStepComplete(state, 'npm');
                printSuccess(`Published to NPM${options.alpha ? ' (alpha tag)' : ''}`);
                
                // Verify NPM publication
                await new Promise(resolve => setTimeout(resolve, 3000));
                const viewCmd = options.alpha 
                    ? 'npm view @wonderwhy-er/desktop-commander dist-tags.alpha'
                    : 'npm view @wonderwhy-er/desktop-commander version';
                const npmVersion = execSilent(viewCmd, { ignoreError: true }).trim();
                if (npmVersion === newVersion) {
                    printSuccess(`NPM publication verified: v${npmVersion}${options.alpha ? ' (alpha)' : ''}`);
                } else {
                    printWarning(`NPM version mismatch: expected ${newVersion}, got ${npmVersion} (may take a moment to propagate)`);
                }
            }
        } else if (isStepComplete(state, 'npm')) {
            printInfo('Step 5/6: NPM publish already completed ✓');
        } else {
            printWarning('Step 5/6: NPM publish skipped (manual override)');
        }
        console.log('');

        // Step 6: Publish to MCP Registry
        const shouldSkipMcp = options.skipMcp || isStepComplete(state, 'mcp');
        if (!shouldSkipMcp) {
            printStep('Step 6/6: Publishing to MCP Registry...');
            
            // Check if mcp-publisher is installed
            const hasMcpPublisher = execSilent('which mcp-publisher', { ignoreError: true });
            if (!hasMcpPublisher) {
                printError('mcp-publisher not found. Install it with: brew install mcp-publisher');
                printError('Or check your PATH if already installed.');
                printError('After installing, run the script again to resume from this step.');
                process.exit(1);
            }

            if (options.dryRun) {
                printWarning('Would publish to MCP Registry: mcp-publisher publish');
                printWarning('Skipping MCP Registry publish (dry run)');
            } else {
                let publishSuccess = false;
                let retryCount = 0;
                const maxRetries = 2;
                
                while (!publishSuccess && retryCount < maxRetries) {
                    try {
                        exec('mcp-publisher publish');
                        publishSuccess = true;
                        markStepComplete(state, 'mcp');
                        printSuccess('Published to MCP Registry');
                    } catch (error) {
                        const errorMsg = error.message || error.toString();
                        retryCount++;
                        
                        // Handle expired token - attempt auto-refresh
                        if (errorMsg.includes('401') || errorMsg.includes('expired') || errorMsg.includes('Unauthorized')) {
                            if (retryCount < maxRetries) {
                                printWarning('Authentication token expired. Attempting to refresh...');
                                try {
                                    exec('mcp-publisher login github', { stdio: 'inherit' });
                                    printSuccess('Token refreshed. Retrying publish...');
                                    continue;
                                } catch (loginError) {
                                    printError('Could not refresh token automatically.');
                                    printError('Please run manually: mcp-publisher login github');
                                    throw error;
                                }
                            }
                        }
                        
                        // Handle deprecated schema - attempt auto-update
                        if (errorMsg.includes('deprecated schema')) {
                            if (retryCount < maxRetries) {
                                printWarning('Schema version deprecated. Attempting to update...');
                                if (updateServerJsonSchema()) {
                                    printSuccess('Schema updated. Retrying publish...');
                                    continue;
                                }
                            }
                        }
                        
                        // Other errors
                        printError('MCP Registry publish failed!');
                        if (errorMsg.includes('422')) {
                            printError('Validation error in server.json. Check the error message above for details.');
                        }
                        throw error;
                    }
                }
                
                // Verify MCP Registry publication
                await new Promise(resolve => setTimeout(resolve, 3000));
                try {
                    const mcpResponse = execSilent('curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.wonderwhy-er/desktop-commander"');
                    const mcpData = JSON.parse(mcpResponse);
                    const mcpVersion = mcpData.servers?.[0]?.version || 'unknown';
                    
                    if (mcpVersion === newVersion) {
                        printSuccess(`MCP Registry publication verified: v${mcpVersion}`);
                    } else {
                        printWarning(`MCP Registry version: ${mcpVersion} (expected ${newVersion}, may take a moment to propagate)`);
                    }
                } catch (verifyError) {
                    printWarning('Could not verify MCP Registry publication');
                }
            }
        } else if (isStepComplete(state, 'mcp')) {
            printInfo('Step 6/6: MCP Registry publish already completed ✓');
        } else {
            printWarning('Step 6/6: MCP Registry publish skipped (manual override)');
        }
        console.log('');

        // All steps complete - clear state
        clearState();

        // Success summary
        const tagName = `v${newVersion}`;
        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║                  🎉 Release Complete! 🎉                 ║');
        console.log('╚══════════════════════════════════════════════════════════╝');
        console.log('');
        printSuccess(`Version: ${newVersion}`);
        printSuccess('NPM: https://www.npmjs.com/package/@wonderwhy-er/desktop-commander');
        printSuccess('MCP Registry: https://registry.modelcontextprotocol.io/');
        printSuccess(`GitHub Tag: https://github.com/wonderwhy-er/DesktopCommanderMCP/releases/tag/${tagName}`);
        console.log('');
        console.log('Next steps:');
        console.log(`  1. Create GitHub release at: https://github.com/wonderwhy-er/DesktopCommanderMCP/releases/new?tag=${tagName}`);
        console.log('  2. Add release notes with features and fixes');
        console.log('  3. Announce on Discord');
        console.log('');

        if (options.dryRun) {
            console.log('');
            printWarning('This was a DRY RUN - no changes were published');
            printWarning('Run without --dry-run to perform the actual release');
            console.log('');
        }

    } catch (error) {
        console.log('');
        printError('Release failed at step: ' + (state.lastStep || 'startup'));
        printError(error.message);
        console.log('');
        printInfo('State has been saved. Simply run the script again to resume from where it failed.');
        printInfo('Use --clear-state to start over from the beginning.');
        console.log('');
        process.exit(1);
    }
}

// Run the script
publishRelease().catch(error => {
    printError('Unexpected error:');
    console.error(error);
    process.exit(1);
});
