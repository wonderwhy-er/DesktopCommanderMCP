#!/usr/bin/env node

import { homedir, platform } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, appendFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

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
const LOG_FILE = join(__dirname, 'uninstall.log');

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

// Main uninstall function
async function uninstall() {
    logToFile('Starting uninstall for ClaudeComputerCommander...');

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

    // Check if desktopCommander is present
    if (!config.mcpServers || !config.mcpServers.desktopCommander) {
        logToFile('Desktop Commander is not found in Claude configuration.');
        logToFile('Nothing to uninstall. Exiting...');
        process.exit(0);
    }

    // Remove desktopCommander server
    delete config.mcpServers.desktopCommander;
    logToFile('Removed desktopCommander from mcpServers configuration');

    // If mcpServers section is now empty, clean it up
    if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
        logToFile('Removed empty mcpServers section from configuration');
    }

    try {
        // Write the updated config back
        writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2), 'utf8');
        logToFile(`Successfully updated Claude configuration at: ${claudeConfigPath}`);
    } catch (err) {
        logToFile(`Error writing Claude configuration: ${err.message}`, true);
        logToFile('Please ensure you have write permissions to the Claude config directory.');
        logToFile('You can manually remove the desktopCommander entry from the mcpServers section in:');
        logToFile(`${claudeConfigPath}`);
        process.exit(1);
    }

    // Final message
    logToFile('\nUninstallation completed successfully!');
    logToFile('Please restart Claude Desktop to apply the changes.');
    logToFile('\nNote: This only removes the server configuration from Claude.');
    logToFile('To completely remove the package, run:');
    logToFile('npm uninstall -g @jasondsmith72/desktop-commander');
}

// Run the uninstall
uninstall().catch(err => {
    logToFile(`Unhandled error during uninstall: ${err.message}`, true);
    process.exit(1);
});
