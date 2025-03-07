#!/usr/bin/env node

import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine OS and set appropriate config path and command
const isWindows = platform() === 'win32';
const claudeConfigPath = isWindows
    ? join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
    : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

// Create backup filename with timestamp
const getBackupFilename = (originalPath) => {
    const now = new Date();
    const timestamp = `${now.getFullYear()}.${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getDate().toString().padStart(2, '0')}-${now.getHours().toString().padStart(2, '0')}.${now.getMinutes().toString().padStart(2, '0')}`;
    const pathObj = originalPath.split('.');
    const extension = pathObj.pop();
    return `${pathObj.join('.')}-bk-${timestamp}.${extension}`;
};

// Setup logging
const LOG_FILE = join(__dirname, 'setup-custom.log');

function logToFile(message, isError = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp} - ${isError ? 'ERROR: ' : ''}${message}\n`;
    try {
        appendFileSync(LOG_FILE, logMessage);
        // For setup script, we'll still output to console
        console.log(isError ? `ERROR: ${message}` : message);
    } catch (err) {
        // Last resort error handling
        console.error(`Failed to write to log file: ${err.message}`);
    }
}

// Main setup function
async function setup() {
    logToFile('Starting custom setup for ClaudeComputerCommander...');

    // Check if config file exists
    if (!existsSync(claudeConfigPath)) {
        logToFile(`Claude config file not found at: ${claudeConfigPath}`, true);
        logToFile('Please make sure Claude Desktop is installed and has been run at least once.');
        process.exit(1);
    }

    // Create backup of config file
    const backupPath = getBackupFilename(claudeConfigPath);
    try {
        copyFileSync(claudeConfigPath, backupPath);
        logToFile(`Created backup of Claude config at: ${backupPath}`);
    } catch (err) {
        logToFile(`Error creating backup: ${err.message}`, true);
        logToFile('Please make sure you have permissions to write to the Claude config directory.');
        process.exit(1);
    }

    // Read config content
    let configContent;
    try {
        configContent = readFileSync(claudeConfigPath, 'utf8');
        logToFile('Successfully read Claude configuration');
    } catch (err) {
        logToFile(`Error reading Claude configuration: ${err.message}`, true);
        process.exit(1);
    }

    // Parse config as JSON
    let config;
    try {
        config = JSON.parse(configContent);
        logToFile('Successfully parsed Claude configuration');
    } catch (err) {
        logToFile(`Error parsing Claude configuration: ${err.message}`, true);
        logToFile('The configuration file appears to be invalid JSON.');
        process.exit(1);
    }

    // Ensure mcpServers section exists
    if (!config.mcpServers) {
        config.mcpServers = {};
        logToFile('Added mcpServers section to configuration');
    }

    // Determine if running through npx or locally
    const isNpx = import.meta.url.endsWith('dist/setup-claude-custom.js');

    // Add or update the desktop commander server configuration
    const serverConfig = isNpx ? {
        "command": "npx",
        "args": [
            "@jasondsmith72/desktop-commander"
        ]
    } : {
        "command": "node",
        "args": [
            join(__dirname, 'dist', 'index.js')
        ]
    };

    // Add desktopCommander server
    config.mcpServers.desktopCommander = serverConfig;
    logToFile('Added desktopCommander to mcpServers configuration');

    // Create the updated config content
    const updatedConfigContent = JSON.stringify(config, null, 2);

    // Log the config changes that would be made
    logToFile('\nHere is the configuration that needs to be applied to Claude:');
    logToFile('-----------------------------------------------------------------');
    logToFile(updatedConfigContent);
    logToFile('-----------------------------------------------------------------');
    
    // Provide manual instructions
    logToFile('\nMANUAL CONFIGURATION INSTRUCTIONS:');
    logToFile('1. Open your Claude Desktop config file at:');
    logToFile(`   ${claudeConfigPath}`);
    logToFile('2. Replace the current content with the configuration shown above');
    logToFile('3. Save the file');
    logToFile('4. Restart Claude Desktop if it is currently running');
    logToFile('\nAfter applying these changes, the desktopCommander MCP server will be available in Claude.');
    
    // Final message
    logToFile('\nSetup instructions generated successfully!');
}

// Run the setup
setup().catch(err => {
    logToFile(`Unhandled error during setup: ${err.message}`, true);
    process.exit(1);
});
