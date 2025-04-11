import path from 'path';
import process from 'process';
import os from 'os';

// Use user's home directory for configuration files
const USER_HOME = os.homedir();
const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const LOG_FILE = path.join(CONFIG_DIR, 'server.log');
export const ERROR_LOG_FILE = path.join(CONFIG_DIR, 'error.log');

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds
