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
    console.log('  node scripts/publish-release.cjs --clear-state # Reset state and start over');
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
        printStep(`Bump type: ${options.bumpType}`);
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
            const bumpCommand = options.bumpType === 'minor' ? 'npm run bump:minor' :
                               options.bumpType === 'major' ? 'npm run bump:major' :
                               'npm run bump';
            exec(bumpCommand);

            const newPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            newVersion = newPackageJson.version;
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
                exec(`git tag ${tagName}`);
                exec('git push origin main');
                exec(`git push origin ${tagName}`);
                printSuccess(`Tag ${tagName} created and pushed`);
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
                printWarning('Would publish to NPM: npm publish');
                printWarning('Skipping NPM publish (dry run)');
            } else {
                exec('npm publish');
                markStepComplete(state, 'npm');
                printSuccess('Published to NPM');
                
                // Verify NPM publication
                await new Promise(resolve => setTimeout(resolve, 3000));
                const npmVersion = execSilent('npm view @wonderwhy-er/desktop-commander version', { ignoreError: true }).trim();
                if (npmVersion === newVersion) {
                    printSuccess(`NPM publication verified: v${npmVersion}`);
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
        const shouldSkipMcp = isStepComplete(state, 'mcp');
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
                try {
                    exec('mcp-publisher publish');
                    markStepComplete(state, 'mcp');
                    printSuccess('Published to MCP Registry');
                    
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
                    } catch (error) {
                        printWarning('Could not verify MCP Registry publication');
                    }
                } catch (error) {
                    printError('MCP Registry publish failed!');
                    if (error.message.includes('401') || error.message.includes('expired')) {
                        printError('Authentication token expired. Please run: mcp-publisher login github');
                        printError('After logging in, run the script again to resume from this step.');
                    } else if (error.message.includes('422')) {
                        printError('Validation error in server.json. Check the error message above for details.');
                        printError('After fixing the issue, run the script again to resume from this step.');
                    }
                    throw error;
                }
            }
        } else {
            printInfo('Step 6/6: MCP Registry publish already completed ✓');
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
