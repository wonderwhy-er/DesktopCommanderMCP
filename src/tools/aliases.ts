import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { logEvent } from '../monitoring/dashboard.js';

interface CommandAlias {
  name: string;
  command: string;
  description?: string;
  createdAt: string;
  lastUsed?: string;
  useCount: number;
}

// Alias configuration
interface AliasConfig {
  aliases: CommandAlias[];
}

// Constants
const CONFIG_DIR = path.join(os.homedir(), '.claude-commander');
const ALIASES_PATH = path.join(CONFIG_DIR, 'aliases.json');

// Default configuration
const defaultConfig: AliasConfig = {
  aliases: []
};

// Load aliases configuration
export async function loadAliases(): Promise<AliasConfig> {
  try {
    // Ensure config directory exists
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    
    // Try to read existing aliases file
    const configData = await fs.readFile(ALIASES_PATH, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // If file doesn't exist, create default config
    await saveAliases(defaultConfig);
    return defaultConfig;
  }
}

// Save aliases configuration
async function saveAliases(config: AliasConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(ALIASES_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// Create a new command alias
export async function createAlias(
  name: string,
  command: string,
  description?: string
): Promise<CommandAlias> {
  // Load existing aliases
  const config = await loadAliases();
  
  // Check if alias already exists
  const existingIndex = config.aliases.findIndex(alias => alias.name === name);
  
  if (existingIndex >= 0) {
    throw new Error(`Alias '${name}' already exists`);
  }
  
  // Create new alias
  const now = new Date().toISOString();
  const newAlias: CommandAlias = {
    name,
    command,
    description,
    createdAt: now,
    useCount: 0
  };
  
  // Add to config
  config.aliases.push(newAlias);
  await saveAliases(config);
  
  // Log event
  await logEvent('alias_created', {
    name,
    command,
    description
  });
  
  return newAlias;
}

// Update an existing command alias
export async function updateAlias(
  name: string,
  updates: {
    command?: string;
    description?: string;
  }
): Promise<CommandAlias> {
  // Load existing aliases
  const config = await loadAliases();
  
  // Find alias to update
  const aliasIndex = config.aliases.findIndex(alias => alias.name === name);
  
  if (aliasIndex === -1) {
    throw new Error(`Alias '${name}' not found`);
  }
  
  // Update alias properties
  if (updates.command !== undefined) {
    config.aliases[aliasIndex].command = updates.command;
  }
  
  if (updates.description !== undefined) {
    config.aliases[aliasIndex].description = updates.description;
  }
  
  await saveAliases(config);
  
  // Log event
  await logEvent('alias_updated', {
    name,
    updates
  });
  
  return config.aliases[aliasIndex];
}

// Delete a command alias
export async function deleteAlias(name: string): Promise<boolean> {
  // Load existing aliases
  const config = await loadAliases();
  
  // Find and remove alias
  const initialLength = config.aliases.length;
  config.aliases = config.aliases.filter(alias => alias.name !== name);
  
  // If nothing was removed, alias didn't exist
  if (config.aliases.length === initialLength) {
    return false;
  }
  
  await saveAliases(config);
  
  // Log event
  await logEvent('alias_deleted', {
    name
  });
  
  return true;
}

// Get all defined aliases
export async function listAliases(): Promise<CommandAlias[]> {
  const config = await loadAliases();
  return config.aliases;
}

// Get a specific alias by name
export async function getAlias(name: string): Promise<CommandAlias | null> {
  const config = await loadAliases();
  return config.aliases.find(alias => alias.name === name) || null;
}

// Process a command with alias expansion
export async function processCommand(commandString: string): Promise<string> {
  // Load aliases
  const config = await loadAliases();
  
  // Check if command starts with an alias
  const firstWord = commandString.trim().split(/\s+/)[0];
  const alias = config.aliases.find(a => a.name === firstWord);
  
  if (!alias) {
    // No alias found, return original command
    return commandString;
  }
  
  // Update alias usage statistics
  alias.lastUsed = new Date().toISOString();
  alias.useCount += 1;
  
  await saveAliases(config);
  
  // Log event
  await logEvent('alias_used', {
    name: alias.name,
    useCount: alias.useCount
  });
  
  // Replace the alias with its command
  const args = commandString.slice(firstWord.length).trim();
  return `${alias.command} ${args}`.trim();
}

// Create some default useful aliases
export async function createDefaultAliases(): Promise<void> {
  const defaultAliases = [
    {
      name: 'ls',
      command: 'list_directory .',
      description: 'List files in current directory'
    },
    {
      name: 'cat',
      command: 'read_file',
      description: 'Read a file content'
    },
    {
      name: 'mkdir',
      command: 'create_directory',
      description: 'Create a directory'
    },
    {
      name: 'ps',
      command: 'list_processes',
      description: 'List running processes'
    },
    {
      name: 'dashboard',
      command: 'start_monitoring_dashboard',
      description: 'Start the monitoring dashboard'
    },
    {
      name: 'backup',
      command: 'backup_file',
      description: 'Create a backup of a file'
    }
  ];
  
  // Load existing aliases
  const config = await loadAliases();
  let created = 0;
  
  for (const defaultAlias of defaultAliases) {
    // Only create if it doesn't already exist
    if (!config.aliases.some(a => a.name === defaultAlias.name)) {
      await createAlias(
        defaultAlias.name,
        defaultAlias.command,
        defaultAlias.description
      );
      created++;
    }
  }
  
  if (created > 0) {
    console.log(`Created ${created} default aliases`);
  }
}
