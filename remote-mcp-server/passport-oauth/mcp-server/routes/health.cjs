/**
 * Health Check Routes for MCP OAuth Server
 */

const express = require('express');
const router = express.Router();

/**
 * Setup health check routes
 */
function setupHealthRoutes(connectionManager) {
  
  /**
   * Health Check Endpoint
   * GET /health
   */
  router.get('/health', (req, res) => {
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();
    const sseStats = connectionManager.getStats();
    
    const healthData = {
      status: 'healthy',
      service: 'mcp-oauth-server',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: {
        seconds: Math.floor(uptime),
        human: formatUptime(uptime)
      },
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024),
        rss: Math.round(memoryUsage.rss / 1024 / 1024)
      },
      sse: sseStats,
      oauth: {
        introspection_url: process.env.OAUTH_INTROSPECTION_URL,
        remote_server_url: process.env.REMOTE_SERVER_URL,
        cache_enabled: true
      },
      environment: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch
      }
    };
    
    res.json(healthData);
  });

  /**
   * Readiness Check
   * GET /ready
   */
  router.get('/ready', async (req, res) => {
    try {
      // Check OAuth server connectivity
      const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
      const fetch = require('cross-fetch');
      
      const oauthHealthResponse = await fetch(`${oauthServerUrl}/health`, {
        timeout: 5000
      });
      
      const oauthHealthy = oauthHealthResponse.ok;
      
      // Check remote server connectivity (if configured)
      let remoteServerHealthy = true;
      const remoteServerUrl = process.env.REMOTE_SERVER_URL;
      
      if (remoteServerUrl) {
        try {
          const remoteHealthResponse = await fetch(`${remoteServerUrl}/health`, {
            timeout: 5000
          });
          remoteServerHealthy = remoteHealthResponse.ok;
        } catch (error) {
          remoteServerHealthy = false;
        }
      }
      
      const ready = oauthHealthy && remoteServerHealthy;
      
      res.status(ready ? 200 : 503).json({
        ready,
        checks: {
          oauth_server: {
            status: oauthHealthy ? 'healthy' : 'unhealthy',
            url: oauthServerUrl
          },
          remote_server: {
            status: remoteServerHealthy ? 'healthy' : 'unhealthy',
            url: remoteServerUrl,
            configured: !!remoteServerUrl
          },
          sse_connections: {
            status: 'healthy',
            active_connections: connectionManager.getStats().total_connections
          }
        },
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('[Health] Readiness check failed:', error);
      
      res.status(503).json({
        ready: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * Liveness Check
   * GET /live
   */
  router.get('/live', (req, res) => {
    // Simple liveness check - if we can respond, we're alive
    res.json({
      alive: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  /**
   * Metrics Endpoint
   * GET /metrics
   */
  router.get('/metrics', (req, res) => {
    const metrics = {
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
      memory_usage_bytes: process.memoryUsage(),
      sse_connections: connectionManager.getStats(),
      environment: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
      }
    };
    
    res.json(metrics);
  });

  /**
   * Deep Health Check (requires authentication)
   * GET /health/deep
   */
  router.get('/health/deep', async (req, res) => {
    try {
      const checks = {};
      
      // OAuth server check
      try {
        const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
        const fetch = require('cross-fetch');
        
        const startTime = Date.now();
        const oauthResponse = await fetch(`${oauthServerUrl}/.well-known/oauth-authorization-server`, {
          timeout: 10000
        });
        const responseTime = Date.now() - startTime;
        
        checks.oauth_metadata = {
          status: oauthResponse.ok ? 'pass' : 'fail',
          response_time_ms: responseTime,
          url: `${oauthServerUrl}/.well-known/oauth-authorization-server`
        };
        
        if (oauthResponse.ok) {
          const metadata = await oauthResponse.json();
          checks.oauth_metadata.endpoints = {
            authorization: metadata.authorization_endpoint,
            token: metadata.token_endpoint,
            introspection: metadata.introspection_endpoint
          };
        }
      } catch (error) {
        checks.oauth_metadata = {
          status: 'fail',
          error: error.message
        };
      }
      
      // Remote server check
      const remoteServerUrl = process.env.REMOTE_SERVER_URL;
      if (remoteServerUrl) {
        try {
          const startTime = Date.now();
          const remoteResponse = await fetch(`${remoteServerUrl}/health`, {
            timeout: 10000
          });
          const responseTime = Date.now() - startTime;
          
          checks.remote_server = {
            status: remoteResponse.ok ? 'pass' : 'fail',
            response_time_ms: responseTime,
            url: `${remoteServerUrl}/health`
          };
        } catch (error) {
          checks.remote_server = {
            status: 'fail',
            error: error.message
          };
        }
      } else {
        checks.remote_server = {
          status: 'skip',
          reason: 'Not configured'
        };
      }
      
      // SSE check
      checks.sse = {
        status: 'pass',
        ...connectionManager.getStats()
      };
      
      const allPassed = Object.values(checks).every(check => 
        check.status === 'pass' || check.status === 'skip'
      );
      
      res.status(allPassed ? 200 : 503).json({
        status: allPassed ? 'pass' : 'fail',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        checks
      });
      
    } catch (error) {
      console.error('[Health] Deep health check failed:', error);
      
      res.status(500).json({
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);
  
  return parts.join(' ') || '0s';
}

module.exports = { setupHealthRoutes };