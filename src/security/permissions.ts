import path from 'path';
import os from 'os';
import fs from 'fs/promises';

// Define permission levels
export enum PermissionLevel {
  NONE = 0,     // No access
  READ = 1,     // Read-only access
  WRITE = 2,    // Read and write access
  EXECUTE = 3,  // Read, write, and execute commands
  FULL = 4      // Full access (all operations)
}

// Define permission names for better readability
export const PermissionNames = {
  [PermissionLevel.NONE]: 'No Access',
  [PermissionLevel.READ]: 'Read-Only',
  [PermissionLevel.WRITE]: 'Read & Write',
  [PermissionLevel.EXECUTE]: 'Read, Write & Execute',
  [PermissionLevel.FULL]: 'Full Access'
};

// Directory permission interface
interface DirectoryPermission {
  path: string;
  level: PermissionLevel;
}

// Default directory permissions
const defaultDirectoryPermissions: DirectoryPermission[] = [
  { path: '~', level: PermissionLevel.READ },
  { path: '~/Documents', level: PermissionLevel.WRITE },
  { path: '~/Projects', level: PermissionLevel.EXECUTE },
  { path: '.', level: PermissionLevel.WRITE }
];

// Security configuration
interface SecurityConfig {
  directoryPermissions: DirectoryPermission[];
  maxCommandTimeout: number;
  loggingEnabled: boolean;
  logRetentionDays: number;
}

// Default security configuration
const defaultSecurityConfig: SecurityConfig = {
  directoryPermissions: defaultDirectoryPermissions,
  maxCommandTimeout: 60000, // 1 minute
  loggingEnabled: true,
  logRetentionDays: 7
};

// Path to security config file
const CONFIG_PATH = path.join(os.homedir(), '.claude-commander', 'security.json');

// Load security configuration
export async function loadSecurityConfig(): Promise<SecurityConfig> {
  try {
    // Ensure the config directory exists
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    
    // Try to load existing config
    const configData = await fs.readFile(CONFIG_PATH, 'utf8');
    const loadedConfig = JSON.parse(configData);
    
    // Merge with default config to ensure all fields exist
    return {
      ...defaultSecurityConfig,
      ...loadedConfig,
      // Convert directory permission objects back to the correct type
      directoryPermissions: loadedConfig.directoryPermissions?.map((dp: any) => ({
        path: dp.path,
        level: dp.level as PermissionLevel
      })) || defaultSecurityConfig.directoryPermissions
    };
  } catch (error) {
    // If file doesn't exist or is invalid, create default config
    await saveSecurityConfig(defaultSecurityConfig);
    return defaultSecurityConfig;
  }
}

// Save security configuration
export async function saveSecurityConfig(config: SecurityConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// Get permission level for a specific path
export async function getPathPermission(requestedPath: string): Promise<PermissionLevel> {
  const config = await loadSecurityConfig();
  const expandedPath = expandPath(requestedPath);
  const normalizedPath = path.normalize(expandedPath).toLowerCase();
  
  // Find the most specific matching directory permission
  let bestMatch: DirectoryPermission | null = null;
  let longestMatchLength = 0;
  
  for (const dirPerm of config.directoryPermissions) {
    const expandedDirPath = expandPath(dirPerm.path);
    const normalizedDirPath = path.normalize(expandedDirPath).toLowerCase();
    
    // Check if requested path is within this directory
    if (normalizedPath.startsWith(normalizedDirPath)) {
      // If this is a longer match than the previous best, update the best match
      if (normalizedDirPath.length > longestMatchLength) {
        bestMatch = dirPerm;
        longestMatchLength = normalizedDirPath.length;
      }
    }
  }
  
  return bestMatch ? bestMatch.level : PermissionLevel.NONE;
}

// Check if an operation is allowed based on permission level
export async function checkPermission(
  requestedPath: string, 
  requiredLevel: PermissionLevel
): Promise<boolean> {
  const actualLevel = await getPathPermission(requestedPath);
  return actualLevel >= requiredLevel;
}

// Add a new directory permission
export async function addDirectoryPermission(
  dirPath: string,
  level: PermissionLevel
): Promise<void> {
  const config = await loadSecurityConfig();
  
  // Check if permission already exists and update it
  const existingIndex = config.directoryPermissions.findIndex(
    dp => dp.path === dirPath
  );
  
  if (existingIndex >= 0) {
    // Update existing permission
    config.directoryPermissions[existingIndex].level = level;
  } else {
    // Add new permission
    config.directoryPermissions.push({ path: dirPath, level });
  }
  
  await saveSecurityConfig(config);
}

// Remove a directory permission
export async function removeDirectoryPermission(dirPath: string): Promise<void> {
  const config = await loadSecurityConfig();
  
  // Filter out the specified directory
  config.directoryPermissions = config.directoryPermissions.filter(
    dp => dp.path !== dirPath
  );
  
  await saveSecurityConfig(config);
}

// Get all directory permissions
export async function getAllDirectoryPermissions(): Promise<DirectoryPermission[]> {
  const config = await loadSecurityConfig();
  return config.directoryPermissions;
}

// Helper function to expand paths (replace ~ with home directory)
function expandPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

// Export the expanded function for use in file operations
export function expandHome(filePath: string): string {
  return expandPath(filePath);
}

// Enhanced security validation for file paths
export async function validateSecurePath(
  requestedPath: string, 
  requiredPermission: PermissionLevel
): Promise<string> {
  const expandedPath = expandPath(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);
  
  // Check permission level for this path
  const hasPermission = await checkPermission(absolute, requiredPermission);
  
  if (!hasPermission) {
    throw new Error(
      `Access denied - insufficient permissions for ${absolute}. ` +
      `Required: ${PermissionNames[requiredPermission]}`
    );
  }
  
  return absolute;
}

// Security audit logging
export async function logSecurityEvent(
  eventType: string,
  details: Record<string, any>
): Promise<void> {
  const config = await loadSecurityConfig();
  
  // Skip logging if disabled
  if (!config.loggingEnabled) return;
  
  const logDir = path.join(os.homedir(), '.claude-commander', 'logs');
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(logDir, `security-${today}.log`);
  
  // Create log directory if it doesn't exist
  await fs.mkdir(logDir, { recursive: true });
  
  // Create log entry
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    eventType,
    ...details
  };
  
  // Append to log file
  await fs.appendFile(
    logFile,
    JSON.stringify(logEntry) + '\n',
    'utf8'
  );
  
  // Clean up old logs
  await cleanupOldLogs(logDir, config.logRetentionDays);
}

// Helper to clean up old log files
async function cleanupOldLogs(logDir: string, retentionDays: number): Promise<void> {
  try {
    const files = await fs.readdir(logDir);
    const now = Date.now();
    
    for (const file of files) {
      if (!file.startsWith('security-') || !file.endsWith('.log')) continue;
      
      const filePath = path.join(logDir, file);
      const stats = await fs.stat(filePath);
      const fileAge = (now - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
      
      if (fileAge > retentionDays) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    // Fail silently - log cleanup is not critical
    console.error('Error cleaning up old logs:', error);
  }
}
