#!/usr/bin/env node

/**
 * Desktop Commander - Complete Release Publishing Script
 * 
 * This script handles the entire release process:
 * 1. Version bump
 * 2. Build project and MCPB bundle
 * 3. Commit and tag
 * 4. Publish to NPM
 * 5. Publish to MCP Registry
 * 6. Verify publications
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
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
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                printError(`Unknown option: ${arg}`);
                console.log("Run 'node scripts/publish-release.js --help' for usage information.");
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
    console.log('  --minor       Bump minor version (default: patch)');
    console.log('  --major       Bump major version (default: patch)');
    console.log('  --skip-tests  Skip running tests');
    console.log('  --dry-run     Simulate the release without publishing');
    console.log('  --help, -h    Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/publish-release.cjs              # Patch release (0.2.16 -> 0.2.17)');
    console.log('  node scripts/publish-release.cjs --minor      # Minor release (0.2.16 -> 0.3.0)');
    console.log('  node scripts/publish-release.cjs --major      # Major release (0.2.16 -> 1.0.0)');
    console.log('  node scripts/publish-release.cjs --dry-run    # Test without publishing');
}

// Main release function
async function publishRelease() {
    const options = parseArgs();

    if (options.help) {
        showHelp();
        return;
    }

    // Check if we're in the right directory
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        printError('package.json not found. Please run this script from the project root.');
        process.exit(1);
    }

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║         Desktop Commander Release Publisher             ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // Get current version
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const currentVersion = packageJson.version;
    printStep(`Current version: ${currentVersion}`);
    printStep(`Bump type: ${options.bumpType}`);

    if (options.dryRun) {
        printWarning('DRY RUN MODE - No changes will be published');
        console.log('');
    }

    try {
        // Step 1: Bump version
        printStep('Step 1/7: Bumping version...');
        const bumpCommand = options.bumpType === 'minor' ? 'npm run bump:minor' :
                           options.bumpType === 'major' ? 'npm run bump:major' :
                           'npm run bump';
        exec(bumpCommand);

        const newPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const newVersion = newPackageJson.version;
        printSuccess(`Version bumped: ${currentVersion} → ${newVersion}`);
        console.log('');

        // Step 2: Build project
        printStep('Step 2/7: Building project...');
        exec('npm run build');
        printSuccess('Project built successfully');
        console.log('');

        // Step 3: Run tests (unless skipped)
        if (!options.skipTests) {
            printStep('Step 3/7: Running tests...');
            exec('npm test');
            printSuccess('All tests passed');
        } else {
            printWarning('Step 3/7: Tests skipped');
        }
        console.log('');

        // Step 4: Build MCPB bundle
        printStep('Step 4/7: Building MCPB bundle...');
        exec('npm run build:mcpb');
        printSuccess('MCPB bundle created');
        console.log('');

        // Step 5: Commit and tag
        printStep('Step 5/7: Creating git commit and tag...');
        
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
        console.log('');

        // Step 6: Publish to NPM
        printStep('Step 6/7: Publishing to NPM...');
        
        // Check NPM authentication
        const npmUser = execSilent('npm whoami', { ignoreError: true }).trim();
        if (!npmUser) {
            printError('Not logged into NPM. Please run "npm login" first.');
            process.exit(1);
        }
        printSuccess(`NPM user: ${npmUser}`);

        if (options.dryRun) {
            printWarning('Would publish to NPM: npm publish');
            printWarning('Skipping NPM publish (dry run)');
        } else {
            exec('npm publish');
            printSuccess('Published to NPM');
            
            // Verify NPM publication
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
            const npmVersion = execSilent('npm view @wonderwhy-er/desktop-commander version', { ignoreError: true }).trim();
            if (npmVersion === newVersion) {
                printSuccess(`NPM publication verified: v${npmVersion}`);
            } else {
                printWarning(`NPM version mismatch: expected ${newVersion}, got ${npmVersion} (may take a moment to propagate)`);
            }
        }
        console.log('');

        // Step 7: Publish to MCP Registry
        printStep('Step 7/7: Publishing to MCP Registry...');
        
        // Check if mcp-publisher is installed
        const hasMcpPublisher = execSilent('mcp-publisher --version', { ignoreError: true });
        if (!hasMcpPublisher) {
            printError('mcp-publisher not found. Install it with: brew install mcp-publisher');
            process.exit(1);
        }

        if (options.dryRun) {
            printWarning('Would publish to MCP Registry: mcp-publisher publish');
            printWarning('Skipping MCP Registry publish (dry run)');
        } else {
            exec('mcp-publisher publish');
            printSuccess('Published to MCP Registry');
            
            // Verify MCP Registry publication
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
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
        }
        console.log('');

        // Success summary
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
        printError('Release failed!');
        printError(error.message);
        process.exit(1);
    }
}

// Run the script
publishRelease().catch(error => {
    printError('Unexpected error:');
    console.error(error);
    process.exit(1);
});
