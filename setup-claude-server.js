import { homedir, platform } from 'os';
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
const GA_API_SECRET = '5M0mC--2S_6t94m8WrI60A';   // Replace with your GA4 API Secre
const GA_BASE_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;

// Generate a unique anonymous ID using UUID - consistent with privacy policy
let uniqueUserId = 'unknown';

try {
    // Use randomUUID from crypto module instead of machine-id
    // This generates a truly random identifier not tied to hardware
    uniqueUserId = randomUUID();
} catch (error) {
    // Fall back to a semi-unique identifier if UUID generation fails
    uniqueUserId = `random-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

// Setup tracking
let setupSteps = []; // Track setup progress
let setupStartTime = Date.now();


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

const getVersion = async () => {
    try {
        const packageJson = await import('./package.json', { assert: { type: 'json' } });
        return packageJson.default.version;
    } catch {
        return 'unknown'
    }
};

// Function to detect shell environmen
function detectShell() {
  // Check for Windows shells
  if (process.platform === 'win32') {
    if (process.env.TERM_PROGRAM === 'vscode') return 'vscode-terminal';
    if (process.env.WT_SESSION) return 'windows-terminal';
    if (process.env.SHELL?.includes('bash')) return 'git-bash';
    if (process.env.TERM?.includes('xterm')) return 'xterm-on-windows';
    if (process.env.ComSpec?.toLowerCase().includes('powershell')) return 'powershell';
    if (process.env.PROMPT) return 'cmd';

    // WSL detection
    if (process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
      return `wsl-${process.env.WSL_DISTRO_NAME || 'unknown'}`;
    }

    return 'windows-unknown';
  }

  // Unix-based shells
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

  // Terminal emulators and IDE terminals
  if (process.env.TERM_PROGRAM) {
    return process.env.TERM_PROGRAM.toLowerCase();
  }

  return 'unknown-shell';
}

// Function to determine execution context
function getExecutionContext() {
  // Check if running from npx
  const isNpx = process.env.npm_lifecycle_event === 'npx' ||
                process.env.npm_execpath?.includes('npx') ||
                process.env._?.includes('npx') ||
                import.meta.url.includes('node_modules');

  // Check if installed globally
  const isGlobal = process.env.npm_config_global === 'true' ||
                   process.argv[1]?.includes('node_modules/.bin');

  // Check if it's run from a script in package.json
  const isNpmScript = !!process.env.npm_lifecycle_script;

  return {
    runMethod: isNpx ? 'npx' : (isGlobal ? 'global' : (isNpmScript ? 'npm_script' : 'direct')),
    isCI: !!process.env.CI || !!process.env.GITHUB_ACTIONS || !!process.env.TRAVIS || !!process.env.CIRCLECI,
    shell: detectShell()
  };
}

// Helper function to get standard environment properties for tracking
let npmVersionCache = null;

// Enhanced version with step tracking - will replace the original after initialization
async function enhancedGetTrackingProperties(additionalProps = {}) {
  const propertiesStep = addSetupStep('get_tracking_properties');
  try {
    if (npmVersionCache === null) {
      npmVersionCache = await getNpmVersion();
    }

    const context = getExecutionContext();
    const version = await getVersion();

    updateSetupStep(propertiesStep, 'completed');
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
    updateSetupStep(propertiesStep, 'failed', error);
    return {
      platform: platform(),
      node_version: nodeVersion,
      error: error.message,
      engagement_time_msec: "100",
      ...additionalProps
    };
  }
}

// Enhanced tracking function with retries and better error handling
// This replaces the basic implementation for all tracking after initialization
async function trackEvent(eventName, additionalProps = {}) {
    const trackingStep = addSetupStep(`track_event_${eventName}`);

    if (!GA_MEASUREMENT_ID || !GA_API_SECRET) {
        updateSetupStep(trackingStep, 'skipped', new Error('GA not configured'));
        return;
    }

    // Add retry capability
    const maxRetries = 2;
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
        try {
            attempt++;

            // Get enriched properties
            const eventProperties = await enhancedGetTrackingProperties(additionalProps);

            // Prepare GA4 payload
            const payload = {
                client_id: uniqueUserId,
                non_personalized_ads: false,
                timestamp_micros: Date.now() * 1000,
                events: [{
                    name: eventName,
                    params: eventProperties
                }]
            };

            // Send to Google Analytics
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

                // Set timeout to prevent blocking
                const timeoutId = setTimeout(() => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                }, 5000); // Increased timeout to 5 seconds

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

            updateSetupStep(trackingStep, 'completed');
            return result;

        } catch (error) {
            lastError = error;
            logToFile(`Error tracking event ${eventName} (attempt ${attempt}/${maxRetries + 1}): ${error}`, true);

            if (attempt <= maxRetries) {
                // Wait before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }

    // All retries failed
    updateSetupStep(trackingStep, 'failed', lastError);
    return false;
}

// Ensure tracking completes before process exits
async function ensureTrackingCompleted(eventName, additionalProps = {}, timeoutMs = 6000) {
    return new Promise(async (resolve) => {
        const timeoutId = setTimeout(() => {
            logToFile(`Tracking timeout for ${eventName}`, true);
            resolve(false);
        }, timeoutMs);

        try {
            await trackEvent(eventName, additionalProps);
            clearTimeout(timeoutId);
            resolve(true);
        } catch (error) {
            clearTimeout(timeoutId);
            logToFile(`Failed to complete tracking for ${eventName}: ${error}`, true);
            resolve(false);
        }
    });
}


// Fix for Windows ESM path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Setup logging early to capture everything
const LOG_FILE = join(__dirname, 'setup.log');

function logToFile(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${isError ? 'ERROR: ' : ''}${message}\n`;
    try {
        appendFileSync(LOG_FILE, logMessage);
        // For setup script, we'll still output to console but in JSON forma
        const jsonOutput = {
            type: isError ? 'error' : 'info',
            timestamp,
            message
        };
        process.stdout.write(JSON.stringify(jsonOutput) + '\n');
    } catch (err) {
        // Last resort error handling
        process.stderr.write(JSON.stringify({
            type: 'error',
            timestamp: new Date().toISOString(),
            message: `Failed to write to log file: ${err.message}`
        }) + '\n');
    }
}

// Setup global error handlers
process.on('uncaughtException', async (error) => {
    logToFile(`Uncaught exception: ${error.stack || error.message}`, true);
    await trackEvent('npx_setup_uncaught_exception', { error: error.message });
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    logToFile(`Unhandled rejection at: ${promise}, reason: ${reason}`, true);
    await trackEvent('npx_setup_unhandled_rejection', { error: String(reason) });
    process.exit(1);
});

// Track when the process is about to exi
let isExiting = false;
process.on('exit', () => {
    if (!isExiting) {
        isExiting = true;
        // Synchronous tracking for exit handler
        logToFile('Process is exiting. Some tracking events may not be sent.');
    }
});


// Function to check for debug mode argument
function isDebugMode() {
    return process.argv.includes('--debug');
}

// Initial tracking - ensure it completes before continuing
await ensureTrackingCompleted('npx_setup_start', {
    argv: process.argv.join(' '),
    start_time: new Date().toISOString()
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
        // Fallback for other platforms
        claudeConfigPath = join(homedir(), '.claude_desktop_config.json');
}



// Tracking step functions
function addSetupStep(step, status = 'started', error = null) {
    const timestamp = Date.now();
    setupSteps.push({
        step,
        status,
        timestamp,
        timeFromStart: timestamp - setupStartTime,
        error: error ? error.message || String(error) : null
    });
    return setupSteps.length - 1; // Return the index for later updates
}

function updateSetupStep(index, status, error = null) {
    if (setupSteps[index]) {
        const timestamp = Date.now();
        setupSteps[index].status = status;
        setupSteps[index].completionTime = timestamp;
        setupSteps[index].timeFromStart = timestamp - setupStartTime;
        if (error) {
            setupSteps[index].error = error.message || String(error);
        }
    }
}

try {
    // Only dependency is node-machine-id
    const machineIdInitStep = addSetupStep('initialize_machine_id');
    try {
        const machineIdModule = await import('node-machine-id');
        // Get a unique user ID
        uniqueUserId = machineIdModule.machineIdSync();
        updateSetupStep(machineIdInitStep, 'completed');
    } catch (error) {
        // Fall back to a semi-unique identifier if machine-id is not available
        uniqueUserId = `${platform()}-${process.env.USER || process.env.USERNAME || 'unknown'}-${Date.now()}`;
        updateSetupStep(machineIdInitStep, 'fallback', error);
    }
} catch (error) {
    logToFile(`Error initializing user ID: ${error}`, true);
    addSetupStep('initialize_machine_id', 'failed', error);
}




async function execAsync(command) {
    const execStep = addSetupStep(`exec_${command.substring(0, 20)}...`);
    return new Promise((resolve, reject) => {
        // Use PowerShell on Windows for better Unicode support and consistency
        const actualCommand = isWindows
        ? `cmd.exe /c ${command}`
        : command;

        exec(actualCommand, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                updateSetupStep(execStep, 'failed', error);
                reject(error);
                return;
            }
            updateSetupStep(execStep, 'completed');
            resolve({ stdout, stderr });
        });
    });
}

async function restartClaude() {
    const restartStep = addSetupStep('restart_claude');
    try {
        const platform = process.platform;
        // Track restart attempt
        await trackEvent('npx_setup_restart_claude_attempt', { platform });

        // Try to kill Claude process first
        const killStep = addSetupStep('kill_claude_process');
        try {
            switch (platform) {
                case "win32":
                    await execAsync(
                        `taskkill /F /IM "Claude.exe"`,
                    );
                    break;
                case "darwin":
                    await execAsync(
                        `killall "Claude"`,
                    );
                    break;
                case "linux":
                    await execAsync(
                        `pkill -f "claude"`,
                    );
                    break;
            }
            updateSetupStep(killStep, 'completed');
            await trackEvent('npx_setup_kill_claude_success', { platform });
        } catch (killError) {
            // It's okay if Claude isn't running - update step but continue
            updateSetupStep(killStep, 'no_process_found', killError);
            await trackEvent('npx_setup_kill_claude_not_needed', { platform });
        }

        // Wait a bit to ensure process termination
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Try to start Claude
        const startStep = addSetupStep('start_claude_process');
        try {
            if (platform === "win32") {
                // Windows - note it won't actually start Claude
                logToFile("Windows: Claude restart skipped - requires manual restart");
                updateSetupStep(startStep, 'skipped');
                await trackEvent('npx_setup_start_claude_skipped', { platform });
            } else if (platform === "darwin") {
                await execAsync(`open -a "Claude"`);
                updateSetupStep(startStep, 'completed');
                await trackEvent('npx_setup_start_claude_success', { platform });
            } else if (platform === "linux") {
                await execAsync(`claude`);
                updateSetupStep(startStep, 'completed');
                await trackEvent('npx_setup_start_claude_success', { platform });
            }

            logToFile(`Claude has been restarted.`);
            updateSetupStep(restartStep, 'completed');
            await trackEvent('npx_setup_restart_claude_success', { platform });
        } catch (startError) {
            updateSetupStep(startStep, 'failed', startError);
            await trackEvent('npx_setup_start_claude_error', {
                platform,
                error: startError.message
            });
            throw startError; // Re-throw to handle in the outer catch
        }
    } catch (error) {
        updateSetupStep(restartStep, 'failed', error);
        await trackEvent('npx_setup_restart_claude_error', { error: error.message });
        logToFile(`Failed to restart Claude: ${error}. Please restart it manually.`, true);
        logToFile(`If Claude Desktop is not installed use this link to download https://claude.ai/download`, true);
    }
}


// Main function to export for ESM compatibility
export default async function setup() {
    // Add tracking for setup function entry
    await trackEvent('npx_setup_function_started');

    const setupStep = addSetupStep('main_setup');
    const debugMode = isDebugMode();

    if (debugMode) {
        logToFile('Debug mode enabled. Will configure with Node.js inspector options.');
        await trackEvent('npx_setup_debug_mode', { enabled: true });
    }

    try {
        // Check if config directory exists and create it if necessary
        const configDirStep = addSetupStep('check_config_directory');
        const configDir = dirname(claudeConfigPath);

        try {
            if (!existsSync(configDir)) {
                logToFile(`Creating config directory: ${configDir}`);
                mkdirSync(configDir, { recursive: true });
                await trackEvent('npx_setup_create_config_dir', { path: configDir });
            }
            updateSetupStep(configDirStep, 'completed');
        } catch (dirError) {
            updateSetupStep(configDirStep, 'failed', dirError);
            await trackEvent('npx_setup_create_config_dir_error', {
                path: configDir,
                error: dirError.message
            });
            throw new Error(`Failed to create config directory: ${dirError.message}`);
        }

        // Check if config file exists and create default if no
        const configFileStep = addSetupStep('check_config_file');
        let config;

        if (!existsSync(claudeConfigPath)) {
            logToFile(`Claude config file not found at: ${claudeConfigPath}`);
            logToFile('Creating default config file...');

            // Track new installation
            await trackEvent('npx_setup_create_default_config');

            // Create default config with shell based on platform
            const defaultConfig = {
                "serverConfig": isWindows
                    ? {
                        "command": "cmd.exe",
                        "args": ["/c"]
                      }
                    : {
                        "command": "/bin/sh",
                        "args": ["-c"]
                      }
            };

            try {
                writeFileSync(claudeConfigPath, JSON.stringify(defaultConfig, null, 2));
                logToFile('Default config file created.');
                config = defaultConfig;
                updateSetupStep(configFileStep, 'created');
                await trackEvent('npx_setup_config_file_created');
            } catch (writeError) {
                updateSetupStep(configFileStep, 'create_failed', writeError);
                await trackEvent('npx_setup_config_file_create_error', { error: writeError.message });
                throw new Error(`Failed to create config file: ${writeError.message}`);
            }
        } else {
            // Read existing config
            const readConfigStep = addSetupStep('read_config_file');
            try {
                const configData = readFileSync(claudeConfigPath, 'utf8');
                config = JSON.parse(configData);
                updateSetupStep(readConfigStep, 'completed');
                updateSetupStep(configFileStep, 'exists');
                await trackEvent('npx_setup_config_file_read');
            } catch (readError) {
                updateSetupStep(readConfigStep, 'failed', readError);
                await trackEvent('npx_setup_config_file_read_error', { error: readError.message });
                throw new Error(`Failed to read config file: ${readError.message}`);
            }
        }

        // Prepare the new server config based on OS
        const configPrepStep = addSetupStep('prepare_server_config');

        // Determine if running through npx or locally
        const isNpx = import.meta.url.includes('node_modules');
        await trackEvent('npx_setup_execution_mode', { isNpx });

        // Fix Windows path handling for npx execution
        let serverConfig;

        try {
            if (debugMode) {
                // Use Node.js with inspector flag for debugging
                if (isNpx) {
                    // Debug with npx
                    logToFile('Setting up debug configuration with npx. The process will pause on start until a debugger connects.');
                    // Add environment variables to help with debugging
                    const debugEnv = {
                        "NODE_OPTIONS": "--trace-warnings --trace-exit",
                        "DEBUG": "*"
                    };

                    serverConfig = {
                        "command": isWindows ? "node.exe" : "node",
                        "args": [
                            "--inspect-brk=9229",
                            isWindows ?
                                join(process.env.APPDATA || '', "npm", "npx.cmd").replace(/\\/g, '\\\\') :
                                "$(which npx)",
                            "@wonderwhy-er/desktop-commander@latest"
                        ],
                        "env": debugEnv
                    };
                    await trackEvent('npx_setup_config_debug_npx');
                } else {
                    // Debug with local installation path
                    const indexPath = join(__dirname, 'dist', 'index.js');
                    logToFile('Setting up debug configuration with local path. The process will pause on start until a debugger connects.');
                    // Add environment variables to help with debugging
                    const debugEnv = {
                        "NODE_OPTIONS": "--trace-warnings --trace-exit",
                        "DEBUG": "*"
                    };

                    serverConfig = {
                        "command": isWindows ? "node.exe" : "node",
                        "args": [
                            "--inspect-brk=9229",
                            indexPath.replace(/\\/g, '\\\\') // Double escape backslashes for JSON
                        ],
                        "env": debugEnv
                    };
                    await trackEvent('npx_setup_config_debug_local');
                }
            } else {
                // Standard configuration without debug
                if (isNpx) {
                    serverConfig = {
                        "command": isWindows ? "npx.cmd" : "npx",
                        "args": [
                            "@wonderwhy-er/desktop-commander@latest"
                        ]
                    };
                    await trackEvent('npx_setup_config_standard_npx');
                } else {
                    // For local installation, use absolute path to handle Windows properly
                    const indexPath = join(__dirname, 'dist', 'index.js');
                    serverConfig = {
                        "command": "node",
                        "args": [
                            indexPath.replace(/\\/g, '\\\\') // Double escape backslashes for JSON
                        ]
                    };
                    await trackEvent('npx_setup_config_standard_local');
                }
            }
            updateSetupStep(configPrepStep, 'completed');
        } catch (prepError) {
            updateSetupStep(configPrepStep, 'failed', prepError);
            await trackEvent('npx_setup_config_prep_error', { error: prepError.message });
            throw new Error(`Failed to prepare server config: ${prepError.message}`);
        }

        // Update the config
        const updateConfigStep = addSetupStep('update_config');
        try {
            // Initialize mcpServers if it doesn't exist
            if (!config.mcpServers) {
                config.mcpServers = {};
            }

            // Check if the old "desktopCommander" exists and remove i
            if (config.mcpServers.desktopCommander) {
                logToFile('Found old "desktopCommander" installation. Removing it...');
                delete config.mcpServers.desktopCommander;
                await trackEvent('npx_setup_remove_old_config');
            }

            // Add or update the terminal server config with the proper name "desktop-commander"
            config.mcpServers["desktop-commander"] = serverConfig;

            // Write the updated config back
            writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf8');
            updateSetupStep(updateConfigStep, 'completed');
            await trackEvent('npx_setup_update_config');
        } catch (updateError) {
            updateSetupStep(updateConfigStep, 'failed', updateError);
            await trackEvent('npx_setup_update_config_error', { error: updateError.message });
            throw new Error(`Failed to update config: ${updateError.message}`);
        }

        logToFile('Successfully added MCP server to Claude configuration!');
        logToFile(`Configuration location: ${claudeConfigPath}`);

        if (debugMode) {
            logToFile('\nTo use the debug server:\n1. Restart Claude if it\'s currently running\n2. The server will be available as "desktop-commander-debug" in Claude\'s MCP server list\n3. Connect your debugger to port 9229');
        } else {
            logToFile('\nTo use the server:\n1. Restart Claude if it\'s currently running\n2. The server will be available as "desktop-commander" in Claude\'s MCP server list');
        }

        // Try to restart Claude
        await restartClaude();

        // Mark the main setup as completed
        updateSetupStep(setupStep, 'completed');

        // Ensure final tracking event is sent before exi
        await ensureTrackingCompleted('npx_setup_complete', {
            total_steps: setupSteps.length,
            total_time_ms: Date.now() - setupStartTime
        });

        return true;
    } catch (error) {
        updateSetupStep(setupStep, 'failed', error);
        // Send detailed info about the failure
        await ensureTrackingCompleted('npx_setup_final_error', {
            error: error.message,
            error_stack: error.stack,
            total_steps: setupSteps.length,
            last_successful_step: setupSteps.filter(s => s.status === 'completed').pop()?.step || 'none'
        });

        logToFile(`Error updating Claude configuration: ${error}`, true);
        return false;
    }
}

// Allow direct execution
if (process.argv.length >= 2 && process.argv[1] === fileURLToPath(import.meta.url)) {
    setup().then(success => {
        if (!success) {
            process.exit(1);
        }
    }).catch(async error => {
        await ensureTrackingCompleted('npx_setup_fatal_error', {
            error: error.message,
            error_stack: error.stack
        });
        logToFile(`Fatal error: ${error}`, true);
        process.exit(1);
    });
}