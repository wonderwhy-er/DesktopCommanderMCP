import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logSecurityEvent } from '../security/permissions.js';

interface FileVersion {
  id: string;
  path: string;
  timestamp: string;
  hash: string;
  backupPath: string;
  metadata: {
    size: number;
    operation: string;
    operationBy?: string;
  };
}

// Store version history in-memory for quick access
const versionHistoryCache: Map<string, FileVersion[]> = new Map();

// Constants
const MAX_VERSIONS_PER_FILE = 10;
const BACKUP_DIR = path.join(os.homedir(), '.claude-commander', 'backups');

// Initialize backup directory
export async function initializeBackupSystem(): Promise<void> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await loadVersionHistory();
}

// Load version history from disk
async function loadVersionHistory(): Promise<void> {
  try {
    const indexPath = path.join(BACKUP_DIR, 'version-index.json');
    const indexContent = await fs.readFile(indexPath, 'utf8');
    const versionIndex = JSON.parse(indexContent);
    
    // Populate cache from file
    for (const [filePath, versions] of Object.entries(versionIndex)) {
      versionHistoryCache.set(filePath, versions as FileVersion[]);
    }
  } catch (error) {
    // If index doesn't exist, create it
    await saveVersionHistory();
  }
}

// Save version history to disk
async function saveVersionHistory(): Promise<void> {
  const versionIndex: Record<string, FileVersion[]> = {};
  
  // Convert Map to object for serialization
  for (const [filePath, versions] of versionHistoryCache.entries()) {
    versionIndex[filePath] = versions;
  }
  
  const indexPath = path.join(BACKUP_DIR, 'version-index.json');
  await fs.writeFile(indexPath, JSON.stringify(versionIndex, null, 2), 'utf8');
}

// Create a hash of file contents
async function createFileHash(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (error) {
    // For new files that don't exist yet
    return 'new-file';
  }
}

// Create a backup of a file before modification
export async function createBackup(
  filePath: string,
  operation: string = 'manual'
): Promise<FileVersion> {
  // Create backup directory
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  
  // Generate unique version ID and timestamp
  const timestamp = new Date().toISOString();
  const versionId = crypto.randomUUID();
  
  // Create backup filename with date and version ID
  const backupFilename = path.basename(filePath) + 
    `.${timestamp.replace(/:/g, '-')}.${versionId.slice(0, 8)}`;
  const backupPath = path.join(BACKUP_DIR, backupFilename);
  
  // Hash file before backup
  const hash = await createFileHash(filePath);
  
  let fileSize = 0;
  try {
    // Copy file to backup location
    try {
      await fs.copyFile(filePath, backupPath);
      const stats = await fs.stat(backupPath);
      fileSize = stats.size;
    } catch (error) {
      // If file doesn't exist yet, create an empty one
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.writeFile(backupPath, '');
      } else {
        throw error;
      }
    }
    
    // Create version object
    const version: FileVersion = {
      id: versionId,
      path: filePath,
      timestamp,
      hash,
      backupPath,
      metadata: {
        size: fileSize,
        operation
      }
    };
    
    // Update version history
    const versions = versionHistoryCache.get(filePath) || [];
    versions.unshift(version); // Add to beginning of array
    
    // Limit number of versions kept
    if (versions.length > MAX_VERSIONS_PER_FILE) {
      const versionsToRemove = versions.slice(MAX_VERSIONS_PER_FILE);
      versions.length = MAX_VERSIONS_PER_FILE;
      
      // Remove backup files for old versions
      for (const oldVersion of versionsToRemove) {
        try {
          await fs.unlink(oldVersion.backupPath);
        } catch (error) {
          // Ignore errors for missing files
        }
      }
    }
    
    versionHistoryCache.set(filePath, versions);
    await saveVersionHistory();
    
    // Log backup creation
    await logSecurityEvent('backup_created', {
      filePath,
      versionId,
      operation,
      size: fileSize
    });
    
    return version;
  } catch (error) {
    // Handle backup errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    await logSecurityEvent('backup_failed', {
      filePath,
      error: errorMessage
    });
    
    throw new Error(`Failed to create backup: ${errorMessage}`);
  }
}

// Get version history for a file
export async function getFileVersions(filePath: string): Promise<FileVersion[]> {
  return versionHistoryCache.get(filePath) || [];
}

// Restore a specific version of a file
export async function restoreVersion(
  filePath: string,
  versionId: string
): Promise<void> {
  const versions = versionHistoryCache.get(filePath) || [];
  const version = versions.find(v => v.id === versionId);
  
  if (!version) {
    throw new Error(`Version ${versionId} not found for ${filePath}`);
  }
  
  // Create a backup of the current state before restoring
  await createBackup(filePath, 'pre-restore');
  
  // Restore from backup file
  await fs.copyFile(version.backupPath, filePath);
  
  // Log restoration
  await logSecurityEvent('version_restored', {
    filePath,
    versionId,
    timestamp: version.timestamp
  });
}

// Compare two versions of a file (return diff)
export async function compareVersions(
  filePath: string,
  versionId1: string,
  versionId2: string = 'latest'
): Promise<string> {
  const versions = versionHistoryCache.get(filePath) || [];
  
  // Get first version
  const version1 = versions.find(v => v.id === versionId1);
  if (!version1) {
    throw new Error(`Version ${versionId1} not found for ${filePath}`);
  }
  
  // Get second version (latest or specified)
  let version2;
  if (versionId2 === 'latest') {
    // Use current file
    version2 = {
      backupPath: filePath,
      id: 'current'
    };
  } else {
    version2 = versions.find(v => v.id === versionId2);
    if (!version2) {
      throw new Error(`Version ${versionId2} not found for ${filePath}`);
    }
  }
  
  // Read contents of both versions
  const content1 = await fs.readFile(version1.backupPath, 'utf8');
  const content2 = await fs.readFile(version2.backupPath, 'utf8');
  
  // Return simple line-by-line diff
  const lines1 = content1.split('\n');
  const lines2 = content2.split('\n');
  
  let diff = `--- ${version1.id} (${version1.timestamp || 'unknown'})\n`;
  diff += `+++ ${version2.id} (${version2.timestamp || 'current'})\n\n`;
  
  // Generate simple diff (this isn't as sophisticated as proper diff tools)
  const maxLines = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLines; i++) {
    const line1 = i < lines1.length ? lines1[i] : '';
    const line2 = i < lines2.length ? lines2[i] : '';
    
    if (line1 !== line2) {
      diff += `- ${line1}\n+ ${line2}\n`;
    } else {
      diff += `  ${line1}\n`;
    }
  }
  
  return diff;
}

// Clean up old backups beyond retention period
export async function cleanupOldBackups(retentionDays: number = 30): Promise<number> {
  const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  let removedCount = 0;
  
  // Process each file's version history
  for (const [filePath, versions] of versionHistoryCache.entries()) {
    const oldVersions = versions.filter(v => {
      const versionTime = new Date(v.timestamp).getTime();
      return versionTime < cutoffTime;
    });
    
    // Keep newer versions
    const newVersions = versions.filter(v => {
      const versionTime = new Date(v.timestamp).getTime();
      return versionTime >= cutoffTime;
    });
    
    // Remove old backup files
    for (const oldVersion of oldVersions) {
      try {
        await fs.unlink(oldVersion.backupPath);
        removedCount++;
      } catch (error) {
        // Ignore errors for missing files
      }
    }
    
    // Update version history
    if (newVersions.length > 0) {
      versionHistoryCache.set(filePath, newVersions);
    } else {
      versionHistoryCache.delete(filePath);
    }
  }
  
  // Save updated version history
  await saveVersionHistory();
  
  // Log cleanup results
  await logSecurityEvent('backup_cleanup', {
    retentionDays,
    removedCount
  });
  
  return removedCount;
}

// Get total backup stats
export async function getBackupStats(): Promise<{
  totalFiles: number;
  totalVersions: number;
  totalSize: number;
  oldestBackup: string;
  newestBackup: string;
}> {
  let totalVersions = 0;
  let totalSize = 0;
  let oldestDate = new Date();
  let newestDate = new Date(0);
  
  for (const versions of versionHistoryCache.values()) {
    totalVersions += versions.length;
    
    for (const version of versions) {
      try {
        const stats = await fs.stat(version.backupPath);
        totalSize += stats.size;
        
        const versionDate = new Date(version.timestamp);
        if (versionDate < oldestDate) {
          oldestDate = versionDate;
        }
        if (versionDate > newestDate) {
          newestDate = versionDate;
        }
      } catch (error) {
        // Ignore errors for missing files
      }
    }
  }
  
  return {
    totalFiles: versionHistoryCache.size,
    totalVersions,
    totalSize,
    oldestBackup: oldestDate.toISOString(),
    newestBackup: newestDate.toISOString()
  };
}
