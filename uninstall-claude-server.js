import { homedir, platform } from 'os';
import fs from 'fs/promises';
import path from 'path';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from "node:child_process";
import { version as nodeVersion } from 'process';
import * as https from 'https';
import { randomUUID } from 'crypto';

// Google Analytics configuration
const GA_MEASUREMENT_ID = 'G-NGGDNL0K4L'; // Replace with your GA4 Measurement ID
const GA_API_SECRET = '5M0mC--2S_6t94m8WrI60A';   // Replace with your GA4 API Secret
const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

// Read clientId and telemetry settings from existing config
let uniqueUserId = 'unknown';
let telemetryEnabled = false; // Default to disabled for privacy

async function getConfigSettings() {
    try {
        const USER_HOME = homedir();
        const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');
        const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
        
        if (existsSync(CONFIG_FILE)) {
            const configData = readFileSync(CONFIG_FILE, 'utf8');
            const config = JSON.parse(configData);
            
            return {
                clientId: config.clientId || randomUUID(),
                telemetryEnabled: config.telemetryEnabled === true // Explicit check for true
            };
        }
        
        // Fallback: generate new ID and default telemetry to false if config doesn't exist
        return {
            clientId: `unknown-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
            telemetryEnabled: false
        };
    } catch (error) {
        // Final fallback
        return {
            clientId: `random-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
            telemetryEnabled: false
        };
    }
}

// Uninstall tracking
let uninstallSteps = [];
let uninstallStartTime = Date.now();

// Fix for Windows ESM path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Setup logging
const LOG_FILE = join(__dirname, 'setup.log');

function logToFile(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${isError ? 'ERROR: ' : ''}${message}\n`;
    try {
        appendFileSync(LOG_FILE, logMessage);
        const jsonOutput = {
            type: isError ? 'error' : 'info',
            timestamp,
            message
        };
        process.stdout.write(`${message}\n`);
    } catch (err) {
        process.stderr.write(`${JSON.stringify({
            type: 'error',
            timestamp: new Date().toISOString(),
            message: `Failed to write to log file: ${err.message}`
        })}\n`);
    }
}

// Function to get npm version
async function getNpmVersion() {
    try {
        return new Promise((resolve, reject) => {
            exec('npm --version', (error, stdout, stderr) => {
                if (error) {
                    resolve('unknown');
                    return;
                }
                resolve(stdout.trim());
            });
        });
    } catch (error) {
        return 'unknown';
    }
}

// Get Desktop Commander version
const getVersion = async () => {
    try {
        if (process.env.npm_package_version) {
            return process.env.npm_package_version;
        }
        
        const versionPath = join(__dirname, 'version.js');
        if (existsSync(versionPath)) {
            const { VERSION } = await import(versionPath);
            return VERSION;
        }

        const packageJsonPath = join(__dirname, 'package.json');
        if (existsSync(packageJsonPath)) {
            const packageJsonContent = readFileSync(packageJsonPath, 'utf8');
            const packageJson = JSON.parse(packageJsonContent);
            if (packageJson.version) {
                return packageJson.version;
            }
        }
        
        return 'unknown';
    } catch (error) {
        return 'unknown';
    }
};
// Function to detect shell environment
function detectShell() {
    if (process.platform === 'win32') {
        if (process.env.TERM_PROGRAM === 'vscode') return 'vscode-terminal';
        if (process.env.WT_SESSION) return 'windows-terminal';
        if (process.env.SHELL?.includes('bash')) return 'git-bash';
        if (process.env.TERM?.includes('xterm')) return 'xterm-on-windows';
        if (process.env.ComSpec?.toLowerCase().includes('powershell')) return 'powershell';
        if (process.env.PROMPT) return 'cmd';

        if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
            return `wsl-${process.env.WSL_DISTRO_NAME || 'unknown'}`;
        }

        return 'windows-unknown';
    }

    if (process.env.SHELL) {
        const shellPath = process.env.SHELL.toLowerCase();
        if (shellPath.includes('bash')) return 'bash';
        if (shellPath.includes('zsh')) return 'zsh';
        if (shellPath.includes('fish')) return 'fish';
        if (shellPath.includes('ksh')) return 'ksh';
        if (shellPath.includes('csh')) return 'csh';
        if (shellPath.includes('dash')) return 'dash';
        return `other-unix-${shellPath.split('/').pop()}`;
    }

    if (process.env.TERM_PROGRAM) {
        return process.env.TERM_PROGRAM.toLowerCase();
    }

    return 'unknown-shell';
}

// Function to determine execution context
function getExecutionContext() {
    const isNpx = process.env.npm_lifecycle_event === 'npx' ||
                  process.env.npm_execpath?.includes('npx') ||
                  process.env._?.includes('npx') ||
                  import.meta.url.includes('node_modules');

    const isGlobal = process.env.npm_config_global === 'true' ||
                     process.argv[1]?.includes('node_modules/.bin');

    const isNpmScript = !!process.env.npm_lifecycle_script;

    return {
        runMethod: isNpx ? 'npx' : (isGlobal ? 'global' : (isNpmScript ? 'npm_script' : 'direct')),
        isCI: !!process.env.CI || !!process.env.GITHUB_ACTIONS || !!process.env.TRAVIS || !!process.env.CIRCLECI,
        shell: detectShell()
    };
}
// Enhanced tracking properties
let npmVersionCache = null;

async function getTrackingProperties(additionalProps = {}) {
    const propertiesStep = addUninstallStep('get_tracking_properties');
    try {
        if (npmVersionCache === null) {
            npmVersionCache = await getNpmVersion();
        }

        const context = getExecutionContext();
        const version = await getVersion();

        updateUninstallStep(propertiesStep, 'completed');
        return {
            platform: platform(),
            node_version: nodeVersion,
            npm_version: npmVersionCache,
            execution_context: context.runMethod,
            is_ci: context.isCI,
            shell: context.shell,
            app_version: version,
            engagement_time_msec: "100",
            ...additionalProps
        };
    } catch (error) {
        updateUninstallStep(propertiesStep, 'failed', error);
        return {
            platform: platform(),
            node_version: nodeVersion,
            error: error.message,
            ...additionalProps
        };
    }
}
// Enhanced tracking function with retries
async function trackEvent(eventName, additionalProps = {}) {
    const trackingStep = addUninstallStep(`track_event_${eventName}`);

    // Check if telemetry is disabled
    if (!telemetryEnabled) {
        updateUninstallStep(trackingStep, 'skipped_telemetry_disabled');
        return true; // Return success since this is expected behavior
    }

    if (!GA_MEASUREMENT_ID || !GA_API_SECRET) {
        updateUninstallStep(trackingStep, 'skipped', new Error('GA not configured'));
        return;
    }

    const maxRetries = 2;
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
        try {
            attempt++;

            const eventProperties = await getTrackingProperties(additionalProps);

            const payload = {
                client_id: uniqueUserId,
                non_personalized_ads: false,
                timestamp_micros: Date.now() * 1000,
                events: [{
                    name: eventName,
                    params: eventProperties
                }]
            };

            const postData = JSON.stringify(payload);
            
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const result = await new Promise((resolve, reject) => {
                const req = https.request(GA_BASE_URL, options);

                const timeoutId = setTimeout(() => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                }, 5000);

                req.on('error', (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                });

                req.on('response', (res) => {
                    clearTimeout(timeoutId);
                    let data = '';

                    res.on('data', (chunk) => {
                        data += chunk;
                    });

                    res.on('error', (error) => {
                        reject(error);
                    });

                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve({ success: true, data });
                        } else {
                            reject(new Error(`HTTP error ${res.statusCode}: ${data}`));
                        }
                    });
                });

                req.write(postData);
                req.end();
            });

            updateUninstallStep(trackingStep, 'completed');
            return result;

        } catch (error) {
            lastError = error;
            if (attempt <= maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    updateUninstallStep(trackingStep, 'failed', lastError);
    return false;
}
// Ensure tracking completes before process exits
async function ensureTrackingCompleted(eventName, additionalProps = {}, timeoutMs = 6000) {
    return new Promise(async (resolve) => {
        const timeoutId = setTimeout(() => {
            resolve(false);
        }, timeoutMs);

        try {
            await trackEvent(eventName, additionalProps);
            clearTimeout(timeoutId);
            resolve(true);
        } catch (error) {
            clearTimeout(timeoutId);
            resolve(false);
        }
    });
}

// Setup global error handlers (will be initialized after config is loaded)
let errorHandlersInitialized = false;

function initializeErrorHandlers() {
    if (errorHandlersInitialized) return;
    
    process.on('uncaughtException', async (error) => {
        if (telemetryEnabled) {
            await trackEvent('uninstall_uncaught_exception', { error: error.message });
        }
        setTimeout(() => {
            process.exit(1);
        }, 1000);
    });

    process.on('unhandledRejection', async (reason, promise) => {
        if (telemetryEnabled) {
            await trackEvent('uninstall_unhandled_rejection', { error: String(reason) });
        }
        setTimeout(() => {
            process.exit(1);
        }, 1000);
    });

    errorHandlersInitialized = true;
}

// Track when the process is about to exit
let isExiting = false;
process.on('exit', () => {
    if (!isExiting) {
        isExiting = true;
    }
});

// Determine OS and set appropriate config path
const os = platform();
const isWindows = os === 'win32';
let claudeConfigPath;

switch (os) {
    case 'win32':
        claudeConfigPath = join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
        break;
    case 'darwin':
        claudeConfigPath = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        break;
    case 'linux':
        claudeConfigPath = join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
        break;
    default:
        claudeConfigPath = join(homedir(), '.claude_desktop_config.json');
}
// Step tracking functions
function addUninstallStep(step, status = 'started', error = null) {
    const timestamp = Date.now();
    uninstallSteps.push({
        step,
        status,
        timestamp,
        timeFromStart: timestamp - uninstallStartTime,
        error: error ? error.message || String(error) : null
    });
    return uninstallSteps.length - 1;
}

function updateUninstallStep(index, status, error = null) {
    if (uninstallSteps[index]) {
        const timestamp = Date.now();
        uninstallSteps[index].status = status;
        uninstallSteps[index].completionTime = timestamp;
        uninstallSteps[index].timeFromStart = timestamp - uninstallStartTime;
        if (error) {
            uninstallSteps[index].error = error.message || String(error);
        }
    }
}

async function execAsync(command) {
    const execStep = addUninstallStep(`exec_${command.substring(0, 20)}...`);
    return new Promise((resolve, reject) => {
        const actualCommand = isWindows
            ? `cmd.exe /c ${command}`
            : command;

        exec(actualCommand, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                updateUninstallStep(execStep, 'failed', error);
                reject(error);
                return;
            }
            updateUninstallStep(execStep, 'completed');
            resolve({ stdout, stderr });
        });
    });
}
// Backup configuration before removal
async function createConfigBackup(configPath) {
    const backupStep = addUninstallStep('create_config_backup');
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${configPath}.backup.${timestamp}`;
        
        if (existsSync(configPath)) {
            const configData = readFileSync(configPath, 'utf8');
            writeFileSync(backupPath, configData, 'utf8');
            updateUninstallStep(backupStep, 'completed');
            logToFile(`Configuration backup created: ${backupPath}`);
            await trackEvent('uninstall_backup_created');
            return backupPath;
        } else {
            updateUninstallStep(backupStep, 'no_config_file');
            return null;
        }
    } catch (error) {
        updateUninstallStep(backupStep, 'failed', error);
        await trackEvent('uninstall_backup_failed', { error: error.message });
        logToFile(`Failed to create backup: ${error.message}`, true);
        return null;
    }
}

// Restore configuration from backup
async function restoreFromBackup(backupPath) {
    if (!backupPath || !existsSync(backupPath)) {
        return false;
    }

    try {
        const backupData = readFileSync(backupPath, 'utf8');
        writeFileSync(claudeConfigPath, backupData, 'utf8');
        logToFile(`Configuration restored from backup: ${backupPath}`);
        await trackEvent('uninstall_backup_restored');
        return true;
    } catch (error) {
        logToFile(`Failed to restore from backup: ${error.message}`, true);
        await trackEvent('uninstall_backup_restore_failed', { error: error.message });
        return false;
    }
}

async function restartClaude() {
    const restartStep = addUninstallStep('restart_claude');
    try {
        const platform = process.platform;
        logToFile('Attempting to restart Claude...');
        await trackEvent('uninstall_restart_claude_attempt');

        // Try to kill Claude process first
        const killStep = addUninstallStep('kill_claude_process');
        try {
            switch (platform) {
                case "win32":
                    await execAsync(`taskkill /F /IM "Claude.exe"`);
                    break;
                case "darwin":
                    await execAsync(`killall "Claude"`);
                    break;
                case "linux":
                    await execAsync(`pkill -f "claude"`);
                    break;
            }
            updateUninstallStep(killStep, 'completed');
            logToFile("Claude process terminated successfully");
            await trackEvent('uninstall_kill_claude_success');
        } catch (killError) {
            updateUninstallStep(killStep, 'no_process_found', killError);
            logToFile("Claude process not found or already terminated");
            await trackEvent('uninstall_kill_claude_not_needed');
        }

        // Wait a bit to ensure process termination
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Try to start Claude
        const startStep = addUninstallStep('start_claude_process');
        try {
            if (platform === "win32") {
                logToFile("Windows: Claude restart skipped - please restart Claude manually");
                updateUninstallStep(startStep, 'skipped');
                await trackEvent('uninstall_start_claude_skipped');
            } else if (platform === "darwin") {
                await execAsync(`open -a "Claude"`);
                updateUninstallStep(startStep, 'completed');
                logToFile("✅ Claude has been restarted automatically!");
                await trackEvent('uninstall_start_claude_success');
            } else if (platform === "linux") {
                await execAsync(`claude`);
                updateUninstallStep(startStep, 'completed');
                logToFile("✅ Claude has been restarted automatically!");
                await trackEvent('uninstall_start_claude_success');
            } else {
                logToFile('To complete uninstallation, restart Claude if it\'s currently running');
                updateUninstallStep(startStep, 'manual_required');
            }
            
            updateUninstallStep(restartStep, 'completed');
            await trackEvent('uninstall_restart_claude_success');
        } catch (startError) {
            updateUninstallStep(startStep, 'failed', startError);
            await trackEvent('uninstall_start_claude_error', {
                error: startError.message
            });
            logToFile(`Could not automatically restart Claude: ${startError.message}. Please restart it manually.`);
        }
    } catch (error) {
        updateUninstallStep(restartStep, 'failed', error);
        await trackEvent('uninstall_restart_claude_error', { error: error.message });
        logToFile(`Failed to restart Claude: ${error.message}. Please restart it manually.`, true);
    }
}
async function removeDesktopCommanderConfig() {
    const configStep = addUninstallStep('remove_mcp_config');
    let backupPath = null;
    
    try {
        // Check if config file exists
        if (!existsSync(claudeConfigPath)) {
            updateUninstallStep(configStep, 'no_config_file');
            logToFile(`Claude config file not found at: ${claudeConfigPath}`);
            logToFile('✅ Desktop Commander was not configured or already removed.');
            await trackEvent('uninstall_config_not_found');
            return true;
        }

        // Create backup before making changes
        backupPath = await createConfigBackup(claudeConfigPath);

        // Read existing config
        let config;
        const readStep = addUninstallStep('read_config_file');
        try {
            const configData = readFileSync(claudeConfigPath, 'utf8');
            config = JSON.parse(configData);
            updateUninstallStep(readStep, 'completed');
        } catch (readError) {
            updateUninstallStep(readStep, 'failed', readError);
            await trackEvent('uninstall_config_read_error', { error: readError.message });
            throw new Error(`Failed to read config file: ${readError.message}`);
        }

        // Check if mcpServers exists
        if (!config.mcpServers) {
            updateUninstallStep(configStep, 'no_mcp_servers');
            logToFile('No MCP servers configured in Claude.');
            logToFile('✅ Desktop Commander was not configured or already removed.');
            await trackEvent('uninstall_no_mcp_servers');
            return true;
        }
        // Track what we're removing
        const serversToRemove = [];
        
        if (config.mcpServers["desktop-commander"]) {
            serversToRemove.push("desktop-commander");
        }

        if (serversToRemove.length === 0) {
            updateUninstallStep(configStep, 'not_found');
            logToFile('Desktop Commander MCP server not found in configuration.');
            logToFile('✅ Desktop Commander was not configured or already removed.');
            await trackEvent('uninstall_server_not_found');
            return true;
        }

        // Remove the server configurations
        const removeStep = addUninstallStep('remove_server_configs');
        try {
            serversToRemove.forEach(serverName => {
                delete config.mcpServers[serverName];
                logToFile(`Removed "${serverName}" from Claude configuration`);
            });

            updateUninstallStep(removeStep, 'completed');
            await trackEvent('uninstall_servers_removed');
        } catch (removeError) {
            updateUninstallStep(removeStep, 'failed', removeError);
            await trackEvent('uninstall_servers_remove_error', { error: removeError.message });
            throw new Error(`Failed to remove server configs: ${removeError.message}`);
        }        // Write the updated config back
        const writeStep = addUninstallStep('write_updated_config');
        try {
            writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf8');
            updateUninstallStep(writeStep, 'completed');
            updateUninstallStep(configStep, 'completed');
            logToFile('✅ Desktop Commander successfully removed from Claude configuration');
            logToFile(`Configuration updated at: ${claudeConfigPath}`);
            await trackEvent('uninstall_config_updated');
        } catch (writeError) {
            updateUninstallStep(writeStep, 'failed', writeError);
            await trackEvent('uninstall_config_write_error', { error: writeError.message });
            
            // Try to restore from backup
            if (backupPath) {
                logToFile('Attempting to restore configuration from backup...');
                const restored = await restoreFromBackup(backupPath);
                if (restored) {
                    throw new Error(`Failed to write updated config, but backup was restored: ${writeError.message}`);
                } else {
                    throw new Error(`Failed to write updated config and backup restoration failed: ${writeError.message}`);
                }
            } else {
                throw new Error(`Failed to write updated config: ${writeError.message}`);
            }
        }

        return true;
    } catch (error) {
        updateUninstallStep(configStep, 'failed', error);
        await trackEvent('uninstall_config_error', { error: error.message });
        logToFile(`Error removing Desktop Commander configuration: ${error.message}`, true);
        
        // Try to restore from backup if we have one
        if (backupPath) {
            logToFile('Attempting to restore configuration from backup...');
            await restoreFromBackup(backupPath);
        }
        
        return false;
    }
}
// Main uninstall function
export default async function uninstall() {
    // Initialize clientId and telemetry settings from existing config
    const configSettings = await getConfigSettings();
    uniqueUserId = configSettings.clientId;
    telemetryEnabled = configSettings.telemetryEnabled;
    
    // Initialize error handlers now that telemetry setting is known
    initializeErrorHandlers();
    
    // Log telemetry status for transparency
    if (!telemetryEnabled) {
        logToFile('Telemetry disabled - no analytics will be sent');
    }
    
    // Initial tracking (only if telemetry enabled)
    await ensureTrackingCompleted('uninstall_start');

    const mainStep = addUninstallStep('main_uninstall');

    try {
        logToFile('Starting Desktop Commander uninstallation...');
        
        // Remove the server configuration from Claude
        const configRemoved = await removeDesktopCommanderConfig();
        
        if (configRemoved) {
            // Try to restart Claude
            // await restartClaude();
            
            updateUninstallStep(mainStep, 'completed');
            
            const appVersion = await getVersion();
            logToFile(`\n✅ Desktop Commander has been successfully uninstalled!`);
            logToFile('The MCP server has been removed from Claude\'s configuration.');

            logToFile('\nIf you want to reinstall later, you can run:');
            logToFile('npx @wonderwhy-er/desktop-commander@latest setup');

            logToFile('\n🎁 We\'re sorry to see you leaving, we’d love to understand your decision not to use Desktop Commander.')
            logToFile('In return for a brief 30-minute call, we’ll send you a $20 Amazon gift card as a thank-you.');
            logToFile('To get a gift card, please fill out this form:');
            logToFile(' https://tally.so/r/w8lyRo');


            logToFile('\nThank you for using Desktop Commander! 👋\n');
            
            // Send final tracking event
            await ensureTrackingCompleted('uninstall_complete');
            
            return true;        
        } else {
            updateUninstallStep(mainStep, 'failed_config_removal');
            
            logToFile('\n❌ Uninstallation completed with errors.');
            logToFile('You may need to manually remove Desktop Commander from Claude\'s configuration.');
            logToFile(`Configuration file location: ${claudeConfigPath}\n`);

            logToFile('\n🎁 We\'re sorry to see you leaving, we\'d love to understand your decision not to use Desktop Commander.')
            logToFile('In return for a brief 30-minute call, we\'ll send you a $20 Amazon gift card as a thank-you.');
            logToFile('To get a gift card, please fill out this form:');
            logToFile(' https://tally.so/r/w8lyRo');
            
            await ensureTrackingCompleted('uninstall_partial_failure');
            
            return false;
        }
    } catch (error) {
        updateUninstallStep(mainStep, 'fatal_error', error);
        
        await ensureTrackingCompleted('uninstall_fatal_error', {
            error: error.message,
            error_stack: error.stack,
            last_successful_step: uninstallSteps.filter(s => s.status === 'completed').pop()?.step || 'none'
        });
        
        logToFile(`Fatal error during uninstallation: ${error.message}`, true);
        logToFile('\n❌ Uninstallation failed.');
        logToFile('You may need to manually remove Desktop Commander from Claude\'s configuration.');
        logToFile(`Configuration file location: ${claudeConfigPath}\n`);

        logToFile('\n🎁 We\'re sorry to see you leaving, we\'d love to understand your decision not to use Desktop Commander.')
        logToFile('In return for a brief 30-minute call, we\'ll send you a $20 Amazon gift card as a thank-you.');
        logToFile('To get a gift card, please fill out this form:');
        logToFile('https://tally.so/r/w8lyRo');
        return false;
    }
}

// Allow direct execution
if (process.argv.length >= 2 && process.argv[1] === fileURLToPath(import.meta.url)) {
    uninstall().then(success => {
        if (!success) {
            process.exit(1);
        }
    }).catch(async error => {
        await ensureTrackingCompleted('uninstall_execution_error', {
            error: error.message,
            error_stack: error.stack
        });
        logToFile(`Fatal error: ${error}`, true);
        process.exit(1);
    });
}