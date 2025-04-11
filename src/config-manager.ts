import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import os from 'os';

export interface ServerConfig {
  blockedCommands?: string[];
  defaultShell?: string;
  allowedDirectories?: string[];
  [key: string]: any; // Allow for arbitrary configuration keys
}

/**
 * Singleton config manager for the server
 */
class ConfigManager {
  private configPath: string;
  private config: ServerConfig = {};
  private initialized = false;

  constructor() {
    // Get user's home directory
    const homeDir = os.homedir();
    // Define config directory and file paths
    const configDir = path.join(homeDir, '.claude-server-commander');
    this.configPath = path.join(configDir, 'config.json');
  }

  /**
   * Initialize configuration - load from disk or create default
   */
  async init() {
    if (this.initialized) return;

    try {
      // Ensure config directory exists
      const configDir = path.dirname(this.configPath);
      if (!existsSync(configDir)) {
        await mkdir(configDir, { recursive: true });
      }

      // Check if config file exists
      try {
        await fs.access(this.configPath);
        // Load existing config
        const configData = await fs.readFile(this.configPath, 'utf8');
        this.config = JSON.parse(configData);
      } catch (error) {
        // Config file doesn't exist, create default
        this.config = this.getDefaultConfig();
        await this.saveConfig();
      }

      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize config:', error);
      // Fall back to default config in memory
      this.config = this.getDefaultConfig();
      this.initialized = true;
    }
  }

  /**
   * Alias for init() to maintain backward compatibility
   */
  async loadConfig() {
    return this.init();
  }

  /**
   * Create default configuration
   */
  private getDefaultConfig(): ServerConfig {
    return {
      blockedCommands: [
        "rm -rf /", 
        ":(){ :|:& };:", 
        "> /dev/sda",
        "dd if=/dev/zero of=/dev/sda",
        "mkfs",
        "mkfs.ext4",
        "format",
        "mount",
        "umount",
        "fdisk",
        "dd",
        "sudo",
        "su",
        "passwd",
        "adduser",
        "useradd",
        "usermod",
        "groupadd"
      ],
      defaultShell: os.platform() === 'win32' ? 'powershell.exe' : 'bash',
      allowedDirectories: [process.cwd()]
    };
  }

  /**
   * Save config to disk
   */
  private async saveConfig() {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Get the entire config
   */
  async getConfig(): Promise<ServerConfig> {
    await this.init();
    return { ...this.config };
  }

  /**
   * Get a specific configuration value
   */
  async getValue(key: string): Promise<any> {
    await this.init();
    return this.config[key];
  }

  /**
   * Set a specific configuration value
   */
  async setValue(key: string, value: any): Promise<void> {
    await this.init();
    this.config[key] = value;
    await this.saveConfig();
  }

  /**
   * Update multiple configuration values at once
   */
  async updateConfig(updates: Partial<ServerConfig>): Promise<ServerConfig> {
    await this.init();
    this.config = { ...this.config, ...updates };
    await this.saveConfig();
    return { ...this.config };
  }

  /**
   * Reset configuration to defaults
   */
  async resetConfig(): Promise<ServerConfig> {
    this.config = this.getDefaultConfig();
    await this.saveConfig();
    return { ...this.config };
  }
}

// Export singleton instance
export const configManager = new ConfigManager();