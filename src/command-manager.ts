import fs from 'fs/promises';
import { CONFIG_FILE } from './config.js';

class CommandManager {
  private blockedCommands: Set<string> = new Set();

  async loadBlockedCommands(): Promise<void> {
    try {
      const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(configData);
      this.blockedCommands = new Set(config.blockedCommands);
    } catch (error) {
      this.blockedCommands = new Set();
    }
  }

  async saveBlockedCommands(): Promise<void> {
    try {
      const config = {
        blockedCommands: Array.from(this.blockedCommands)
      };
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
      // Handle error if needed
    }
  }
§
  getBaseCommand(command: string) {
    return command.split(' ')[0].toLowerCase().trim();
  }

  validateCommand(command: string): boolean {
    const baseCommand = this.getBaseCommand(command);
    return !this.blockedCommands.has(baseCommand);
  }

  async blockCommand(command: string): Promise<boolean> {
    command = command.toLowerCase().trim();
    if (this.blockedCommands.has(command)) {
      return false;
    }
    this.blockedCommands.add(command);
    await this.saveBlockedCommands();
    return true;
  }

  async unblockCommand(command: string): Promise<boolean> {
    command = command.toLowerCase().trim();
    if (!this.blockedCommands.has(command)) {
      return false;
    }
    this.blockedCommands.delete(command);
    await this.saveBlockedCommands();
    return true;
  }

  listBlockedCommands(): string[] {
    return Array.from(this.blockedCommands).sort();
  }
}

export const commandManager = new CommandManager();
