import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Detect if Desktop Commander is running in ephemeral mode (Docker MCP Gateway bug)
 * by checking for persistence markers and container indicators
 */
export async function detectPersistenceMode(): Promise<{
  isPersistent: boolean;
  isDockerized: boolean;
  warnings: string[];
  recommendations: string[];
}> {
  const warnings: string[] = [];
  const recommendations: string[] = [];
  let isPersistent = true;
  const isDockerized = process.env.MCP_CLIENT_DOCKER === 'true' || process.env.DOCKER_MCP_IN_CONTAINER === '1';

  try {
    // Test 1: Check if we can create a persistence marker file
    const tempDir = os.tmpdir();
    const markerFile = path.join(tempDir, '.desktop-commander-persistence-test');
    
    try {
      // Try to read existing marker
      const existingMarker = await fs.readFile(markerFile, 'utf8');
      const markerData = JSON.parse(existingMarker);
      
      // Check if marker is from a previous session
      const now = Date.now();
      const markerAge = now - markerData.timestamp;
      
      if (markerAge < 60000) { // Less than 1 minute old
        // Marker exists and is recent - likely persistent
        await fs.writeFile(markerFile, JSON.stringify({
          timestamp: now,
          pid: process.pid,
          sessionId: markerData.sessionId
        }));
      } else {
        // Old marker - this is a new session, possibly ephemeral
        warnings.push('Persistence marker is old, possible ephemeral container detected');
        isPersistent = false;
        
        await fs.writeFile(markerFile, JSON.stringify({
          timestamp: now,
          pid: process.pid,
          sessionId: Math.random().toString(36).substring(7)
        }));
      }
    } catch (error) {
      // No existing marker - create new one
      await fs.writeFile(markerFile, JSON.stringify({
        timestamp: Date.now(),
        pid: process.pid,
        sessionId: Math.random().toString(36).substring(7)
      }));
    }

    // Test 2: Check container filesystem indicators
    if (isDockerized) {
      try {
        // Check if we're in a fresh overlay filesystem
        const procMounts = await fs.readFile('/proc/mounts', 'utf8');
        if (procMounts.includes('overlay') && procMounts.includes('snapshots')) {
          warnings.push('Running in Docker overlay filesystem - check if container is persistent');
        }
      } catch {
        // /proc/mounts not available (non-Linux or no access)
      }

      // Test 3: Check for common ephemeral indicators
      const ephemeralIndicators = [
        'DOCKER_MCP_EPHEMERAL',
        'MCP_TOOL_MODE',
        'EPHEMERAL_CONTAINER'
      ];

      for (const indicator of ephemeralIndicators) {
        if (process.env[indicator]) {
          warnings.push(`Ephemeral mode indicator detected: ${indicator}`);
          isPersistent = false;
        }
      }

      // Check if we have volume mounts (good for persistence)
      try {
        const mounts = await fs.readFile('/proc/mounts', 'utf8');
        const volumeMounts = mounts.split('\n').filter(line => 
          line.includes('/workspace') || 
          line.includes('/app/data') || 
          line.includes('bind')
        );
        
        if (volumeMounts.length > 0) {
          recommendations.push('Volume mounts detected - good for persistence');
        } else {
          warnings.push('No persistent volume mounts detected');
        }
      } catch {
        // Can't read mounts
      }
    }

    // Generate recommendations based on findings
    if (!isPersistent && isDockerized) {
      recommendations.push(
        'PERSISTENCE ISSUE DETECTED: Files may not persist between tool calls',
        'Immediate fix: Run "docker mcp gateway run --long-lived"',
        'Permanent fix: Update Docker MCP catalog with "longLived: true"',
        'See docs/DOCKER_MCP_CONFIGURATION.md for detailed instructions'
      );
    }

    if (isDockerized && warnings.length > 0) {
      recommendations.push(
        'Consider using volume mounts for important data persistence',
        'Monitor container lifecycle with "docker ps" to verify persistence'
      );
    }

  } catch (error) {
    warnings.push(`Error detecting persistence mode: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    isPersistent,
    isDockerized,
    warnings,
    recommendations
  };
}

/**
 * Get Docker MCP Gateway specific information
 */
export async function getDockerMCPInfo(): Promise<{
  isDockerMCP: boolean;
  containerInfo: Record<string, any>;
  persistenceStatus: string;
}> {
  const isDockerMCP = process.env.MCP_CLIENT_DOCKER === 'true';
  const containerInfo: Record<string, any> = {};
  let persistenceStatus = 'unknown';

  if (isDockerMCP) {
    // Collect container-specific environment variables
    const dockerEnvVars = [
      'DOCKER_MCP_IN_CONTAINER',
      'DOCKER_MCP_IN_DIND', 
      'MCP_CLIENT_DOCKER',
      'HOSTNAME',
      'CONTAINER_ID'
    ];

    for (const envVar of dockerEnvVars) {
      if (process.env[envVar]) {
        containerInfo[envVar] = process.env[envVar];
      }
    }

    // Check persistence mode
    const persistenceCheck = await detectPersistenceMode();
    if (persistenceCheck.isPersistent) {
      persistenceStatus = 'persistent';
    } else {
      persistenceStatus = 'ephemeral';
    }

    containerInfo.persistenceWarnings = persistenceCheck.warnings;
    containerInfo.recommendations = persistenceCheck.recommendations;
  }

  return {
    isDockerMCP,
    containerInfo,
    persistenceStatus
  };
}
