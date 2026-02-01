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
  
  // Track fresh fetch status for A/B tests that need network flags
  private freshFetchPromise: Promise<void> | null = null;
  private resolveFreshFetch: (() => void) | null = null;
  private loadedFromCache: boolean = false;

  constructor() {
    const configDir = path.dirname(CONFIG_FILE);
    this.cachePath = path.join(configDir, 'feature-flags.json');
    
    // Use production flags (v2 supports weighted variants)
    this.flagUrl = process.env.DC_FLAG_URL || 
      'https://desktopcommander.app/flags/v2/production.json';
    
    // Set up promise for waiting on fresh fetch
    this.freshFetchPromise = new Promise((resolve) => {
      this.resolveFreshFetch = resolve;
    });
  }

  /**
   * Initialize - load from cache and start background refresh
   */
  async initialize(): Promise<void> {
    try {
      // Load from cache immediately (non-blocking)
      await this.loadFromCache();
      
      // Fetch in background (don't block startup)
      this.fetchFlags().then(() => {
        // Signal that fresh flags are now available
        if (this.resolveFreshFetch) {
          this.resolveFreshFetch();
        }
      }).catch(err => {
        logger.debug('Initial flag fetch failed:', err.message);
        // Still resolve the promise so waiters don't hang forever
        if (this.resolveFreshFetch) {
          this.resolveFreshFetch();
        }
      });
      
      // Start periodic refresh every 5 minutes
      this.refreshInterval = setInterval(() => {
        this.fetchFlags().catch(err => {
          logger.debug('Periodic flag fetch failed:', err.message);
        });
      }, this.cacheMaxAge);
      
      // Allow process to exit even if interval is pending
      // This is critical for proper cleanup when MCP client disconnects
      this.refreshInterval.unref();
      
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
   * Check if flags were loaded from cache (vs fresh fetch)
   */
  wasLoadedFromCache(): boolean {
    return this.loadedFromCache;
  }

  /**
   * Wait for fresh flags to be fetched from network.
   * Use this when you need to ensure flags are loaded before making decisions
   * (e.g., A/B test assignments for new users who don't have a cache yet)
   */
  async waitForFreshFlags(): Promise<void> {
    if (this.freshFetchPromise) {
      await this.freshFetchPromise;
    }
  }

  /**
   * Load flags from local cache
   */
  private async loadFromCache(): Promise<void> {
    try {
      if (!existsSync(this.cachePath)) {
        logger.debug('No feature flag cache found');
        this.loadedFromCache = false;
        return;
      }

      const data = await fs.readFile(this.cachePath, 'utf8');
      const config: FeatureFlags = JSON.parse(data);
      
      if (config.flags) {
        this.flags = config.flags;
        this.lastFetch = Date.now();
        this.loadedFromCache = true;
        logger.debug(`Loaded ${Object.keys(this.flags).length} feature flags from cache`);
      }
    } catch (error) {
      logger.warning('Failed to load feature flags from cache:', error);
      this.loadedFromCache = false;
    }
  }

  /**
   * Fetch flags from remote URL
   */
  private async fetchFlags(): Promise<void> {
    try {
      // Don't log here - runs async and can interfere with MCP clients
      
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
        
        // Save to cache (silently - don't log during async operations
        // as it can interfere with MCP clients that close quickly)
        await this.saveToCache(config);
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
      // Don't log here - this runs async and can cause issues with MCP clients
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
