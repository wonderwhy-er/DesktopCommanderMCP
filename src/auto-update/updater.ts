import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { VERSION } from '../version.js';
import { logEvent } from '../monitoring/dashboard.js';

// Constants
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = path.join(os.homedir(), '.claude-commander');
const UPDATE_CONFIG_PATH = path.join(CONFIG_DIR, 'update-config.json');
const PACKAGE_NAME = '@jasondsmith72/desktop-commander';

// Update configuration interface
interface UpdateConfig {
  lastChecked: string;
  checkFrequency: number; // hours
  autoUpdate: boolean;
  updateChannel: 'stable' | 'beta' | 'latest';
  lastVersion: string;
}

// Default update configuration
const defaultUpdateConfig: UpdateConfig = {
  lastChecked: new Date(0).toISOString(), // Start with epoch time
  checkFrequency: 24, // Check once a day by default
  autoUpdate: false, // Default to manual updates
  updateChannel: 'stable',
  lastVersion: VERSION
};

// Load update configuration
export async function loadUpdateConfig(): Promise<UpdateConfig> {
  try {
    // Ensure config directory exists
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    
    // Try to read existing config file
    const configData = await fs.readFile(UPDATE_CONFIG_PATH, 'utf8');
    const loadedConfig = JSON.parse(configData);
    
    // Merge with default config to ensure all fields exist
    return {
      ...defaultUpdateConfig,
      ...loadedConfig
    };
  } catch (error) {
    // If file doesn't exist, create default config
    await saveUpdateConfig(defaultUpdateConfig);
    return defaultUpdateConfig;
  }
}

// Save update configuration
async function saveUpdateConfig(config: UpdateConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(UPDATE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// Update update configuration
export async function updateConfig(updates: Partial<UpdateConfig>): Promise<UpdateConfig> {
  const config = await loadUpdateConfig();
  const newConfig = { ...config, ...updates };
  await saveUpdateConfig(newConfig);
  
  await logEvent('update_config_changed', {
    oldConfig: config,
    newConfig
  });
  
  return newConfig;
}

// Get the latest available version
async function getLatestVersion(channel: 'stable' | 'beta' | 'latest' = 'stable'): Promise<string> {
  try {
    // Use npm view to get latest version
    const versionTag = channel === 'stable' ? 'latest' : channel;
    const command = `npm view ${PACKAGE_NAME}@${versionTag} version`;
    
    const output = execSync(command, { encoding: 'utf8' }).trim();
    return output;
  } catch (error) {
    console.error('Failed to check for updates:', error);
    throw new Error('Failed to check for latest version');
  }
}

// Check if an update is available
export async function checkForUpdates(force: boolean = false): Promise<{
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}> {
  // Load update config
  const config = await loadUpdateConfig();
  
  // Check if we should skip this check
  const now = new Date();
  const lastChecked = new Date(config.lastChecked);
  const hoursSinceLastCheck = (now.getTime() - lastChecked.getTime()) / (1000 * 60 * 60);
  
  if (!force && hoursSinceLastCheck < config.checkFrequency) {
    return {
      hasUpdate: false,
      currentVersion: VERSION,
      latestVersion: config.lastVersion,
      updateAvailable: false
    };
  }
  
  try {
    // Get latest version
    const latestVersion = await getLatestVersion(config.updateChannel);
    
    // Update the last checked time
    await updateConfig({
      lastChecked: now.toISOString(),
      lastVersion: latestVersion
    });
    
    // Compare versions to see if update is available
    const currentParts = VERSION.split('.').map(p => parseInt(p, 10));
    const latestParts = latestVersion.split('.').map(p => parseInt(p, 10));
    
    let updateAvailable = false;
    
    // Simple semantic version comparison
    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
      const current = i < currentParts.length ? currentParts[i] : 0;
      const latest = i < latestParts.length ? latestParts[i] : 0;
      
      if (latest > current) {
        updateAvailable = true;
        break;
      } else if (current > latest) {
        break;
      }
    }
    
    // Log the update check
    await logEvent('update_check', {
      currentVersion: VERSION,
      latestVersion,
      updateAvailable
    });
    
    return {
      hasUpdate: true,
      currentVersion: VERSION,
      latestVersion,
      updateAvailable
    };
  } catch (error) {
    console.error('Error checking for updates:', error);
    
    // Log the failed update check
    await logEvent('update_check_failed', {
      currentVersion: VERSION,
      error: error instanceof Error ? error.message : String(error)
    });
    
    return {
      hasUpdate: false,
      currentVersion: VERSION,
      latestVersion: 'unknown',
      updateAvailable: false
    };
  }
}

// Perform the update
export async function performUpdate(
  targetVersion: string = 'latest'
): Promise<{
  success: boolean;
  previousVersion: string;
  newVersion: string;
}> {
  try {
    // Log that we're starting an update
    await logEvent('update_started', {
      previousVersion: VERSION,
      targetVersion
    });
    
    // Execute npm update
    const updateChannel = targetVersion === 'latest' ? 'latest' : `@${targetVersion}`;
    const command = `npm install -g ${PACKAGE_NAME}${updateChannel}`;
    
    execSync(command, { stdio: 'inherit' });
    
    // Get the new version after update
    const newVersionCommand = `npm list -g ${PACKAGE_NAME} --depth=0 --json`;
    const output = execSync(newVersionCommand, { encoding: 'utf8' });
    const packageInfo = JSON.parse(output);
    
    const newVersion = packageInfo.dependencies?.[PACKAGE_NAME]?.version || 'unknown';
    
    // Log successful update
    await logEvent('update_successful', {
      previousVersion: VERSION,
      newVersion
    });
    
    return {
      success: true,
      previousVersion: VERSION,
      newVersion
    };
  } catch (error) {
    console.error('Update failed:', error);
    
    // Log failed update
    await logEvent('update_failed', {
      previousVersion: VERSION,
      error: error instanceof Error ? error.message : String(error)
    });
    
    return {
      success: false,
      previousVersion: VERSION,
      newVersion: VERSION
    };
  }
}

// Check and perform auto-update if enabled
export async function autoUpdate(): Promise<void> {
  const config = await loadUpdateConfig();
  
  // Skip if auto-update is disabled
  if (!config.autoUpdate) {
    return;
  }
  
  // Check for updates
  const updateCheck = await checkForUpdates();
  
  // If an update is available, perform it
  if (updateCheck.updateAvailable) {
    console.log(`Auto-updating from ${VERSION} to ${updateCheck.latestVersion}...`);
    await performUpdate(updateCheck.latestVersion);
  }
}

// Start the auto-update scheduler
export async function startAutoUpdateScheduler(): Promise<void> {
  // Initial check on startup
  await autoUpdate();
  
  // Set up recurring check
  setInterval(async () => {
    await autoUpdate();
  }, 60 * 60 * 1000); // Check every hour (will respect frequency setting)
}