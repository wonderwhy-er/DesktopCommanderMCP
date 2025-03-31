import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from "node:child_process";
import { PostHog } from 'posthog-node';
import machineId from 'node-machine-id';
import { version as nodeVersion } from 'process';

const client = new PostHog(
    'phc_TFQqTkCwtFGxlwkXDY3gSs7uvJJcJu8GurfXd6mV063',
    { 
        host: 'https://eu.i.posthog.com',
        flushAt: 1, // send all every time
        flushInterval: 0 //send always
    }
)
// Get a unique user ID
const uniqueUserId = machineId.machineIdSync();

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

// Function to detect shell environment
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
async function getTrackingProperties(additionalProps = {}) {
  if (npmVersionCache === null) {
    npmVersionCache = await getNpmVersion();
  }
  
  const context = getExecutionContext();
  
  return {
    platform: platform(),
    nodeVersion: nodeVersion,
    npmVersion: npmVersionCache,
    executionContext: context.runMethod,
    isCI: context.isCI,
    shell: context.shell,
    timestamp: new Date().toISOString(),
    ...additionalProps
  };
}

// Initial tracking
(async () => {
  client.capture({
    distinctId: uniqueUserId,
    event: 'npx_setup_start',
    properties: await getTrackingProperties()
  });
})();

// Fix for Windows ESM path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine OS and set appropriate config path
const os = platform();
const isWindows = os === 'win32'; // Define isWindows variable
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

// Setup logging
const LOG_FILE = join(__dirname, 'setup.log');

function logToFile(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${isError ? 'ERROR: ' : ''}${message}\n`;
    try {
        appendFileSync(LOG_FILE, logMessage);
        // For setup script, we'll still output to console but in JSON format
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

async function execAsync(command) {
    return new Promise((resolve, reject) => {
      // Use PowerShell on Windows for better Unicode support and consistency
      const actualCommand = isWindows
      ? `cmd.exe /c ${command}`
      : command;

      exec(actualCommand, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
}

async function restartClaude() {
	try {
        const platform = process.platform
        // ignore errors on windows when claude is not running.
        // just silently kill the process
        try  {
            switch (platform) {
                case "win32":

                    await execAsync(
                        `taskkill /F /IM "Claude.exe"`,
                    )
                    break;
                case "darwin":
                    await execAsync(
                        `killall "Claude"`,
                    )
                    break;
                case "linux":
                    await execAsync(
                        `pkill -f "claude"`,
                    )
                    break;
            }
        } catch {}
		await new Promise((resolve) => setTimeout(resolve, 3000))

		if (platform === "win32") {
            // it will never start claude
			// await execAsync(`start "" "Claude.exe"`)
		} else if (platform === "darwin") {
			await execAsync(`open -a "Claude"`)
		} else if (platform === "linux") {
			await execAsync(`claude`)
		}

		logToFile(`Claude has been restarted.`)
	} catch (error) {
        client.capture({
            distinctId: uniqueUserId,
            event: 'npx_setup_restart_claude_error',
            properties: await getTrackingProperties({ error: error.message })
        });
		logToFile(`Failed to restart Claude: ${error}`, true)
	}
}

// Check if config file exists and create default if not
if (!existsSync(claudeConfigPath)) {
    logToFile(`Claude config file not found at: ${claudeConfigPath}`);
    logToFile('Creating default config file...');
    
    // Track new installation
    client.capture({
        distinctId: uniqueUserId,
        event: 'npx_setup_create_default_config',
        properties: await getTrackingProperties()
    });
    
    // Create the directory if it doesn't exist
    const configDir = dirname(claudeConfigPath);
    if (!existsSync(configDir)) {
        import('fs').then(fs => fs.mkdirSync(configDir, { recursive: true }));
    }
    
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
    
    writeFileSync(claudeConfigPath, JSON.stringify(defaultConfig, null, 2));
    logToFile('Default config file created. Please update it with your Claude API credentials.');
}

// Main function to export for ESM compatibility
export default async function setup() {
    try {
        // Read existing config
        const configData = readFileSync(claudeConfigPath, 'utf8');
        const config = JSON.parse(configData);

        // Prepare the new server config based on OS
        // Determine if running through npx or locally
        const isNpx = import.meta.url.includes('node_modules');

        // Fix Windows path handling for npx execution
        let serverConfig;
        if (isNpx) {
            serverConfig = {
                "command": isWindows ? "npx.cmd" : "npx",
                "args": [
                    "@wonderwhy-er/desktop-commander"
                ]
            };
        } else {
            // For local installation, use absolute path to handle Windows properly
            const indexPath = join(__dirname, 'dist', 'index.js');
            serverConfig = {
                "command": "node",
                "args": [
                    indexPath.replace(/\\/g, '\\\\') // Double escape backslashes for JSON
                ]
            };
        }

        // Initialize mcpServers if it doesn't exist
        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Check if the old "desktopCommander" exists and remove it
        if (config.mcpServers.desktopCommander) {
            logToFile('Found old "desktopCommander" installation. Removing it...');
            delete config.mcpServers.desktopCommander;
        }

        // Add or update the terminal server config with the proper name "desktop-commander"
        config.mcpServers["desktop-commander"] = serverConfig;

        // Write the updated config back
        writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf8');
        client.capture({
            distinctId: uniqueUserId,
            event: 'npx_setup_update_config',
            properties: await getTrackingProperties()
        });
        logToFile('Successfully added MCP server to Claude configuration!');
        logToFile(`Configuration location: ${claudeConfigPath}`);
        logToFile('\nTo use the server:\n1. Restart Claude if it\'s currently running\n2. The server will be available as "desktop-commander" in Claude\'s MCP server list');

        await restartClaude();
        
        client.capture({
            distinctId: uniqueUserId,
            event: 'npx_setup_complete',
            properties: await getTrackingProperties()
        });
        await client.shutdown() 
    } catch (error) {
        client.capture({
            distinctId: uniqueUserId,
            event: 'npx_setup_final_error',
            properties: await getTrackingProperties({ error: error.message })
        });
        logToFile(`Error updating Claude configuration: ${error}`, true);
        await client.shutdown() 
        process.exit(1);
    }
}

// Allow direct execution
if (process.argv.length >= 2 && process.argv[1] === fileURLToPath(import.meta.url)) {
    setup().catch(error => {
        logToFile(`Fatal error: ${error}`, true);
        process.exit(1);
    });
}