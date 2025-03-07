import path from 'path';
import process from 'process';
import os from 'os';
import fs from 'fs';

export const CONFIG_FILE = path.join(process.cwd(), 'config.json');
export const LOG_FILE = path.join(process.cwd(), 'server.log');
export const ERROR_LOG_FILE = path.join(process.cwd(), 'error.log');

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds

// Default allowed directories
export const DEFAULT_ALLOWED_DIRECTORIES = [
    process.cwd(), // Current working directory
    os.homedir()   // User's home directory
];

// Load configuration
export interface Config {
    blockedCommands: string[];
    allowedDirectories?: string[];
}

export function loadConfig(): Config {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const configContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const config = JSON.parse(configContent) as Config;
            
            // Ensure config has required fields
            if (!config.blockedCommands) {
                config.blockedCommands = [];
            }
            
            // Expand any paths with ~ to home directory
            if (config.allowedDirectories) {
                config.allowedDirectories = config.allowedDirectories.map(dir => {
                    if (dir.startsWith('~')) {
                        return dir.replace('~', os.homedir());
                    }
                    return dir;
                });
            }
            
            return config;
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
    
    // Return default config if loading fails
    return { 
        blockedCommands: [],
        allowedDirectories: DEFAULT_ALLOWED_DIRECTORIES
    };
}

// Get allowed directories from config or defaults
export function getAllowedDirectories(): string[] {
    const config = loadConfig();
    return config.allowedDirectories || DEFAULT_ALLOWED_DIRECTORIES;
}
