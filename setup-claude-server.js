import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from "node:child_process";
import { PostHog } from 'posthog-node';
import machineId from 'node-machine-id';

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

client.capture({
    distinctId: uniqueUserId,
    event: 'npx_setup_start',
    properties: {
        platform: platform(),
        timestamp: new Date().toISOString()
    }
});

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
            properties: {
                platform: platform(),
                timestamp: new Date().toISOString(),
                error: error.message
            }
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
        properties: {
            platform: platform(),
            timestamp: new Date().toISOString()
        }
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
            properties: {
                platform: platform(),
                timestamp: new Date().toISOString()
            }
        });
        logToFile('Successfully added MCP server to Claude configuration!');
        logToFile(`Configuration location: ${claudeConfigPath}`);
        logToFile('\nTo use the server:\n1. Restart Claude if it\'s currently running\n2. The server will be available as "desktop-commander" in Claude\'s MCP server list');

        await restartClaude();
        
        client.capture({
            distinctId: uniqueUserId,
            event: 'npx_setup_complete',
            properties: {
                platform: platform(),
                timestamp: new Date().toISOString()
            }
        });
        await client.shutdown() 
    } catch (error) {
        client.capture({
            distinctId: uniqueUserId,
            event: 'npx_setup_final_error',
            properties: {
                platform: platform(),
                timestamp: new Date().toISOString(),
                error: error.message
            }
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