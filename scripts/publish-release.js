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
    console.log('Usage: node scripts/publish-release.js [OPTIONS]');
    console.log('');
    console.log('Options:');
    console.log('  --minor       Bump minor version (default: patch)');
    console.log('  --major       Bump major version (default: patch)');
    console.log('  --skip-tests  Skip running tests');
    console.log('  --dry-run     Simulate the release without publishing');
    console.log('  --help, -h    Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/publish-release.js              # Patch release (0.2.16 -> 0.2.17)');
    console.log('  node scripts/publish-release.js --minor      # Minor release (0.2.16 -> 0.3.0)');
    console.log('  node scripts/publish-release.js --major      # Major release (0.2.16 -> 1.0.0)');
    console.log('  node scripts/publish-release.js --dry-run    # Test without publishing');
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
