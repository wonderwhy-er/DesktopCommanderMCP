#!/usr/bin/env node

/**
 * Desktop Commander - Release Trigger Script
 *
 * Publishing is done by CI (.github/workflows/release.yml), triggered by
 * pushing a version tag. This script prepares and fires that trigger:
 *
 * 1. Run tests (or just build with --skip-tests)
 * 2. Bump version (package.json, server.json, src/version.ts)
 * 3. Commit, tag vX.Y.Z, push main + tag  ← this starts the CI release
 *
 * CI then builds the MCPB, creates the GitHub release with the .mcpb asset
 * (picked up by Anthropic's directory scanner), publishes to npm, and
 * publishes to the MCP Registry via OIDC. No local npm login or
 * mcp-publisher setup is needed for a normal release.
 *
 * Alpha releases (--alpha) are the exception: they publish to npm directly
 * from this machine under the `alpha` dist-tag, with no git tag and no CI
 * involvement (CI intentionally rejects pre-release tags).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const REPO_URL = 'https://github.com/wonderwhy-er/DesktopCommanderMCP';

// Colors for output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

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

function exec(command, options = {}) {
    return execSync(command, {
        encoding: 'utf8',
        stdio: options.silent ? 'pipe' : 'inherit',
        ...options,
    });
}

function execSilent(command, options = {}) {
    try {
        return exec(command, { silent: true, ...options });
    } catch (error) {
        if (options.ignoreError) return '';
        throw error;
    }
}

/**
 * Ask the user to confirm before doing anything irreversible.
 * Skipped with --yes. Non-interactive runs (no TTY) must pass --yes.
 */
function confirm(question) {
    if (!process.stdin.isTTY) {
        printError('Not an interactive terminal. Pass --yes to confirm automatically.');
        process.exit(1);
    }
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${question} [y/N] `, answer => {
            rl.close();
            resolve(/^y(es)?$/i.test(answer.trim()));
        });
    });
}

/**
 * Preview the next version for a bump type without changing anything.
 */
function bumpPreview(version, type) {
    const [major, minor, patch] = version.split('.').map(Number);
    if (type === 'major') return `${major + 1}.0.0`;
    if (type === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

/**
 * Calculate alpha version from current version
 * - "0.2.28" → "0.2.29-alpha.0"
 * - "0.2.29-alpha.0" → "0.2.29-alpha.1"
 */
function getAlphaVersion(currentVersion) {
    const alphaMatch = currentVersion.match(/^(\d+\.\d+\.\d+)-alpha\.(\d+)$/);
    if (alphaMatch) {
        return `${alphaMatch[1]}-alpha.${parseInt(alphaMatch[2], 10) + 1}`;
    }
    const [major, minor, patch] = currentVersion.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}-alpha.0`;
}

/**
 * Update version in package.json, server.json, and version.ts
 */
function updateVersionFiles(newVersion) {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

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

    fs.writeFileSync(path.join(process.cwd(), 'src', 'version.ts'), `export const VERSION = '${newVersion}';\n`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        bumpType: 'patch',
        skipTests: false,
        dryRun: false,
        alpha: false,
        help: false,
        yes: false,
        // These switch to dispatch mode: the release runs in CI via
        // `gh workflow run` so the skip flags reach the workflow inputs.
        skipNpm: false,
        skipRegistry: false,
        skipGithubRelease: false,
        tag: '',
    };

    for (const arg of args) {
        switch (arg) {
            case '--minor': options.bumpType = 'minor'; break;
            case '--major': options.bumpType = 'major'; break;
            case '--skip-tests': options.skipTests = true; break;
            case '--alpha': options.alpha = true; break;
            case '--dry-run': options.dryRun = true; break;
            case '--yes':
            case '-y': options.yes = true; break;
            case '--skip-npm': options.skipNpm = true; break;
            case '--skip-registry': options.skipRegistry = true; break;
            case '--skip-github-release': options.skipGithubRelease = true; break;
            case '--help':
            case '-h': options.help = true; break;
            default:
                if (arg.startsWith('--tag=')) {
                    options.tag = arg.slice('--tag='.length);
                    break;
                }
                printError(`Unknown option: ${arg}`);
                console.log("Run 'node scripts/publish-release.cjs --help' for usage information.");
                process.exit(1);
        }
    }

    return options;
}

function showHelp() {
    console.log('Usage: node scripts/publish-release.cjs [OPTIONS]');
    console.log('');
    console.log('Prepares a release and pushes the version tag that triggers the CI');
    console.log('release pipeline (.github/workflows/release.yml). CI does all');
    console.log('publishing: GitHub release + MCPB asset, npm, MCP Registry.');
    console.log('');
    console.log('Options:');
    console.log('  --minor         Bump minor version (default: patch)');
    console.log('  --major         Bump major version (default: patch)');
    console.log('  --skip-tests    Build only instead of running the test suite');
    console.log('  --alpha         Alpha release: publish to npm (alpha tag) from this');
    console.log('                  machine, no git tag, no CI (needs npm login)');
    console.log('  --dry-run       Show what would happen without changing anything');
    console.log('  --yes, -y       Skip the confirmation prompt');
    console.log('  --help, -h      Show this help message');
    console.log('');
    console.log('Partial releases (run in CI via gh workflow dispatch, needs gh login):');
    console.log('  --skip-npm             Skip npm publish');
    console.log('  --skip-registry        Skip MCP Registry publish');
    console.log('  --skip-github-release  Skip GitHub release + MCPB asset');
    console.log('  --tag=vX.Y.Z           Re-release an existing tag instead of cutting a new one');
    console.log('  Any of these switches to dispatch mode: CI runs the tests, bumps,');
    console.log('  tags, and publishes the non-skipped targets.');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/publish-release.cjs              # Patch release (0.2.16 -> 0.2.17)');
    console.log('  node scripts/publish-release.cjs --minor      # Minor release (0.2.16 -> 0.3.0)');
    console.log('  node scripts/publish-release.cjs --dry-run    # Preview without releasing');
    console.log('  node scripts/publish-release.cjs --alpha      # Alpha to npm only');
    console.log('  node scripts/publish-release.cjs --skip-registry        # New release, npm + GitHub only');
    console.log('  node scripts/publish-release.cjs --tag=v0.2.48          # Re-run a failed release');
    console.log('  node scripts/publish-release.cjs --tag=v0.2.48 --skip-npm  # Re-run, registry/release only');
}

/**
 * Dispatch the release to CI with workflow inputs (skip flags and/or an
 * existing tag). Used whenever a flag can't ride on a plain tag push.
 */
async function dispatchRelease(options) {
    if (options.alpha) {
        printError('--alpha cannot be combined with skip flags or --tag (alpha releases are local npm-only).');
        process.exit(1);
    }
    if (options.tag && !/^v\d+\.\d+\.\d+$/.test(options.tag)) {
        printError(`--tag must look like vX.Y.Z (got "${options.tag}")`);
        process.exit(1);
    }

    const ghArgs = ['workflow', 'run', 'release.yml', '--ref', 'main'];
    if (options.tag) {
        ghArgs.push('-f', `tag=${options.tag}`);
    } else {
        ghArgs.push('-f', `bump=${options.bumpType}`);
    }
    if (options.skipNpm) ghArgs.push('-f', 'skip_npm=true');
    if (options.skipRegistry) ghArgs.push('-f', 'skip_registry=true');
    if (options.skipGithubRelease) ghArgs.push('-f', 'skip_github_release=true');

    const command = `gh ${ghArgs.join(' ')}`;

    printStep('Dispatch mode: the release will run in CI with the requested options.');
    if (options.tag) {
        printInfo(`Re-releasing existing tag ${options.tag}`);
    } else {
        printInfo(`CI will run tests, bump (${options.bumpType}), commit, tag, and publish.`);
    }

    const skips = [
        options.skipNpm && 'npm publish',
        options.skipRegistry && 'MCP Registry publish',
        options.skipGithubRelease && 'GitHub release + MCPB asset',
    ].filter(Boolean);
    if (skips.length) {
        printInfo(`CI will SKIP: ${skips.join(', ')}`);
    }
    printInfo(`Command: ${command}`);

    if (options.dryRun) {
        printWarning('DRY RUN - not dispatching');
        return;
    }

    if (!options.yes && !(await confirm('Dispatch this release to CI?'))) {
        printWarning('Aborted, nothing was done.');
        return;
    }

    if (!execSilent('command -v gh', { ignoreError: true }).trim()) {
        printError('gh CLI not found. Install it (brew install gh) and run "gh auth login",');
        printError('or start the release from the GitHub UI: Actions → Release → Run workflow.');
        process.exit(1);
    }

    exec(command);
    printSuccess('Release dispatched to CI');
    printInfo(`Watch it: ${REPO_URL}/actions/workflows/release.yml`);
}

async function publishRelease() {
    const options = parseArgs();

    if (options.help) {
        showHelp();
        return;
    }

    // Skip flags and --tag can't ride on a plain tag push — hand the release
    // to CI through workflow dispatch instead.
    if (options.skipNpm || options.skipRegistry || options.skipGithubRelease || options.tag) {
        await dispatchRelease(options);
        return;
    }

    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        printError('package.json not found. Please run this script from the project root.');
        process.exit(1);
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const currentVersion = packageJson.version;

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║         Desktop Commander Release Publisher             ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    printStep(`Current version: ${currentVersion}`);
    printStep(`Release type: ${options.alpha ? 'alpha (npm only, local)' : options.bumpType + ' (via CI)'}`);
    if (options.dryRun) {
        printWarning('DRY RUN MODE - no changes will be made');
    }
    console.log('');

    // ---------------------------------------------------------------- alpha --
    if (options.alpha) {
        const newVersion = getAlphaVersion(currentVersion);

        const npmUser = execSilent('npm whoami', { ignoreError: true }).trim();
        if (!npmUser && !options.dryRun) {
            printError('Not logged into npm. Please run "npm login" first.');
            process.exit(1);
        }
        if (npmUser) printSuccess(`npm authenticated as: ${npmUser}`);

        printInfo(`Plan: bump ${currentVersion} → ${newVersion}, ${options.skipTests ? 'build' : 'run tests'}, npm publish --tag alpha.`);
        printInfo('No git tag, no CI, no GitHub release, no MCP Registry.');
        console.log('');

        if (options.dryRun) {
            printWarning('DRY RUN - nothing will be changed');
            return;
        }

        if (!options.yes && !(await confirm(`Publish alpha ${newVersion} to npm?`))) {
            printWarning('Aborted, nothing was done.');
            return;
        }

        printStep(`Bumping version: ${currentVersion} → ${newVersion}`);
        updateVersionFiles(newVersion);

        printStep(options.skipTests ? 'Building project...' : 'Running tests (includes build)...');
        exec(options.skipTests ? 'npm run build' : 'npm test');

        printStep('Publishing to npm (alpha tag)...');
        exec('npm publish --tag alpha');
        printSuccess(`Published ${newVersion} to npm under the alpha dist-tag`);
        printInfo('Note: version files now hold the alpha version and are uncommitted.');
        printInfo('Set a stable version before the next regular release.');
        return;
    }

    // --------------------------------------------------------------- stable --
    // Guard: never cut a stable release on top of an alpha version
    if (currentVersion.includes('-')) {
        printError(`Current version "${currentVersion}" is a pre-release.`);
        printError('Set a stable version in package.json (and server.json, src/version.ts) first,');
        printError('or use --alpha for an alpha release.');
        process.exit(1);
    }

    // Guard: releases are cut from main
    const branch = execSilent('git rev-parse --abbrev-ref HEAD', { ignoreError: true }).trim();
    if (branch !== 'main') {
        printError(`Releases must be cut from main (currently on "${branch}").`);
        process.exit(1);
    }

    // Guard: a dirty tree would end up inside the release commit
    const gitStatus = execSilent('git status --porcelain', { ignoreError: true }).trim();
    if (gitStatus) {
        printError('Working tree is not clean. Commit or stash your changes first:');
        console.log(gitStatus);
        process.exit(1);
    }

    // Show the full plan and get one confirmation before anything runs
    const plannedVersion = bumpPreview(currentVersion, options.bumpType);
    console.log('Release plan:');
    console.log(`  1. ${options.skipTests ? 'Build project' : 'Run tests'} (local, nothing changed yet)`);
    console.log(`  2. Bump version ${currentVersion} → ${plannedVersion} and commit`);
    console.log(`  3. Push main + tag v${plannedVersion} to origin — this starts the CI release:`);
    console.log('     build MCPB → publish npm → GitHub release with .mcpb asset');
    console.log('     (picked up by the Claude directory) → publish MCP Registry');
    console.log('');

    if (!options.dryRun && !options.yes && !(await confirm(`Release v${plannedVersion} now?`))) {
        printWarning('Aborted, nothing was done.');
        return;
    }
    console.log('');

    // Step 1: tests/build BEFORE the bump, so a failure leaves nothing behind
    printStep(`Step 1/3: ${options.skipTests ? 'Building project...' : 'Running tests (includes build)...'}`);
    if (options.dryRun) {
        printWarning(`Would run: ${options.skipTests ? 'npm run build' : 'npm test'}`);
    } else {
        exec(options.skipTests ? 'npm run build' : 'npm test');
        printSuccess(options.skipTests ? 'Project built successfully' : 'All tests passed');
    }
    console.log('');

    // Step 2: bump version
    const bumpCommand = options.bumpType === 'minor' ? 'npm run bump:minor' :
                        options.bumpType === 'major' ? 'npm run bump:major' :
                        'npm run bump';
    let newVersion = currentVersion;
    printStep('Step 2/3: Bumping version...');
    if (options.dryRun) {
        printWarning(`Would run: ${bumpCommand}`);
    } else {
        exec(bumpCommand);
        newVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
        printSuccess(`Version bumped: ${currentVersion} → ${newVersion}`);
    }
    console.log('');

    // Step 3: commit, tag, push — the tag push triggers the CI release
    const tagName = `v${newVersion}`;
    printStep('Step 3/3: Committing, tagging, and pushing...');
    if (options.dryRun) {
        printWarning(`Would commit version files and create tag ${tagName}`);
        printWarning(`Would push main and ${tagName} to origin (tag push triggers CI release)`);
        console.log('');
        printWarning('This was a DRY RUN - nothing was changed');
        return;
    }

    exec('git add package.json server.json src/version.ts');
    exec(`git commit -m "Release ${tagName}

Automated release commit with version bump from ${currentVersion} to ${newVersion}"`);
    printSuccess('Version files committed');

    exec(`git tag ${tagName}`);
    printSuccess(`Tag ${tagName} created`);

    exec('git push origin main');
    exec(`git push origin ${tagName}`);
    printSuccess(`Pushed main and ${tagName} — CI release started`);
    console.log('');

    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              🚀 Release handed off to CI 🚀              ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    printSuccess(`Version: ${newVersion}`);
    printInfo(`Watch the release run: ${REPO_URL}/actions/workflows/release.yml`);
    console.log('');
    console.log('CI will now: build the MCPB → create the GitHub release with the');
    console.log('.mcpb asset → publish to npm → publish to the MCP Registry.');
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Confirm the run is green: ${REPO_URL}/actions/workflows/release.yml`);
    console.log(`  2. Polish release notes if needed: ${REPO_URL}/releases/tag/${tagName}`);
    console.log('  3. Announce on Discord');
    console.log('');
    console.log(`If a publish step failed, re-run it with:`);
    console.log(`  gh workflow run release.yml --ref main -f tag=${tagName}`);
    console.log('');
}

publishRelease().catch(error => {
    printError('Release failed:');
    console.error(error.message || error);
    process.exit(1);
});
