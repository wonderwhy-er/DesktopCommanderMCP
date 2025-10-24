import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { CONFIG_FILE } from '../config.js';
import { logger } from './logger.js';

interface FeatureFlags {
  version?: string;
  flags?: Record<string, any>;
}

class FeatureFlagManager {
  private flags: Record<string, any> = {};
  private lastFetch: number = 0;
  private cachePath: string;
  private cacheMaxAge: number = 30 * 60 * 1000;
  private flagUrl: string;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    const configDir = path.dirname(CONFIG_FILE);
    this.cachePath = path.join(configDir, 'feature-flags.json');
    
    // Use production flags
    this.flagUrl = process.env.DC_FLAG_URL || 
      'https://desktopcommander.app/flags/v1/production.json';
  }

  /**
   * Initialize - load from cache and start background refresh
   */
  async initialize(): Promise<void> {
    try {
      // Load from cache immediately (non-blocking)
      await this.loadFromCache();
      
      // Fetch in background (don't block startup)
      this.fetchFlags().catch(err => {
        logger.debug('Initial flag fetch failed:', err.message);
      });
      
      // Start periodic refresh every 5 minutes
      this.refreshInterval = setInterval(() => {
        this.fetchFlags().catch(err => {
          logger.debug('Periodic flag fetch failed:', err.message);
        });
      }, this.cacheMaxAge);
      
      logger.info(`Feature flags initialized (refresh every ${this.cacheMaxAge / 1000}s)`);
    } catch (error) {
      logger.warning('Failed to initialize feature flags:', error);
    }
  }

  /**
   * Get a flag value
   */
  get(flagName: string, defaultValue: any = false): any {
    return this.flags[flagName] !== undefined ? this.flags[flagName] : defaultValue;
  }

  /**
   * Get all flags for debugging
   */
  getAll(): Record<string, any> {
    return { ...this.flags };
  }

  /**
   * Manually refresh flags immediately (for testing)
   */
  async refresh(): Promise<boolean> {
    try {
      await this.fetchFlags();
      return true;
    } catch (error) {
      logger.error('Manual refresh failed:', error);
      return false;
    }
  }

  /**
   * Load flags from local cache
   */
  private async loadFromCache(): Promise<void> {
    try {
      if (!existsSync(this.cachePath)) {
        logger.debug('No feature flag cache found');
        return;
      }

      const data = await fs.readFile(this.cachePath, 'utf8');
      const config: FeatureFlags = JSON.parse(data);
      
      if (config.flags) {
        this.flags = config.flags;
        this.lastFetch = Date.now();
        logger.debug(`Loaded ${Object.keys(this.flags).length} feature flags from cache`);
      }
    } catch (error) {
      logger.warning('Failed to load feature flags from cache:', error);
    }
  }

  /**
   * Fetch flags from remote URL
   */
  private async fetchFlags(): Promise<void> {
    try {
      logger.debug('Fetching feature flags from:', this.flagUrl);
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.flagUrl, {
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
        }
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const config: FeatureFlags = await response.json();
      
      // Update flags
      if (config.flags) {
        this.flags = config.flags;
        this.lastFetch = Date.now();
        
        // Save to cache
        await this.saveToCache(config);
        
        logger.info(`Feature flags updated: ${Object.keys(this.flags).length} flags`);
      }
    } catch (error: any) {
      logger.debug('Failed to fetch feature flags:', error.message);
      // Continue with cached values
    }
  }

  /**
   * Save flags to local cache
   */
  private async saveToCache(config: FeatureFlags): Promise<void> {
    try {
      const configDir = path.dirname(this.cachePath);
      if (!existsSync(configDir)) {
        await fs.mkdir(configDir, { recursive: true });
      }
      
      await fs.writeFile(this.cachePath, JSON.stringify(config, null, 2), 'utf8');
      logger.debug('Saved feature flags to cache');
    } catch (error) {
      logger.warning('Failed to save feature flags to cache:', error);
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}

// Export singleton instance
export const featureFlagManager = new FeatureFlagManager();
