#!/usr/bin/env node

/**
 * Desktop Commander Remote Server with Supabase OAuth and HTTP Transport
 * 
 * This server provides MCP (Model Context Protocol) functionality with:
 * - OAuth 2.0 with PKCE authentication
 * - HTTP transport for MCP protocol
 * - User-specific tool execution
 * - Session management and logging
 * - OAuth discovery endpoints
 * - Official MCP SDK integration
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSupabaseServiceClient } from '../utils/supabase.js';
import { serverLogger } from '../utils/logger.js';



import { createOAuthRouter } from './routes/oauth.js';
import { createMCPRouter } from './routes/mcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Configuration constants - MCP compliant
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || (process.env.NODE_ENV === 'production'
  ? 'https://your-production-domain.com'
  : 'http://localhost:3007');

/**
 * Main MCP Server class
 */
class DesktopCommanderRemoteServer {
  constructor() {
    this.app = express();
    this.port = parseInt(process.env.MCP_SERVER_PORT) || 3007;
    this.host = process.env.MCP_SERVER_HOST || 'localhost';
    this.serverUrl = MCP_SERVER_URL;

    // Initialize components
    // Use Service Client for server-side operations to bypass RLS
    this.supabase = createSupabaseServiceClient();

    // Request tracking
    this.requestCount = 0;
    this.startTime = Date.now();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();

    serverLogger.info('Desktop Commander Remote Server initialized', {
      port: this.port,
      host: this.host,
      environment: process.env.NODE_ENV || 'development'
    });
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // Request tracking
    this.app.use((req, res, next) => {
      this.requestCount++;
      req.requestId = this.requestCount;
      req.startTime = Date.now();

      serverLogger.logRequest(req);
      next();
    });

    // CORS configuration (MCP compliant - single server URL)
    const corsOrigins = process.env.CORS_ORIGINS
      ? JSON.parse(process.env.CORS_ORIGINS)
      : [this.serverUrl]; // Use single MCP server URL

    serverLogger.info('CORS configuration', {
      corsOrigins,
      serverUrl: this.serverUrl
    });

    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Claude Desktop, etc.)
        if (!origin || corsOrigins.includes(origin)) {
          return callback(null, true);
        }

        serverLogger.warn('❌ CORS origin rejected', {
          origin,
          allowed: corsOrigins
        });
        callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    }));

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Serve static files from src/public
    const staticPath = path.join(__dirname, '..', 'public');
    this.app.use(express.static(staticPath));

    serverLogger.info('Static files served from', { path: staticPath });

    // Security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-MCP-Version', '2024-11-05');
      res.setHeader('X-Server-Type', 'Supabase-MCP-HTTP');
      next();
    });

    // Response logging
    this.app.use((req, res, next) => {
      res.on('finish', () => {
        const duration = Date.now() - req.startTime;
        serverLogger.logResponse(req, res, duration);
      });
      next();
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Server info endpoint (public)
    this.app.get('/', (req, res) => {
      res.json({
        service: 'Desktop Commander Remote Server',
        version: '1.0.0',
        protocol_version: '2024-11-05',
        transport: 'http',
        authentication: 'oauth2',
        endpoints: {
          mcp: '/mcp',
          authorize: '/authorize',
          token: '/token',
          register: '/register'
        },
        timestamp: new Date().toISOString()
      });
    });

    // MCP info API endpoint for web interface
    this.app.get('/api/mcp-info', (req, res) => {
      const mcpInfo = {
        mcpServerUrl: this.serverUrl,
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
        redirectUrl: `${this.serverUrl}/auth/callback`,
        authorizationEndpoint: `${this.serverUrl}/authorize`,
        tokenEndpoint: `${this.serverUrl}/token`,
        discoveryEndpoint: `${this.serverUrl}/.well-known/oauth-authorization-server`
      };

      res.json(mcpInfo);
    });

    // Mount OAuth and MCP routers
    this.app.use('/', createOAuthRouter(this.serverUrl, this.supabase));
    this.app.use('/', createMCPRouter(this.supabase));
  }

  /**
   * Setup error handling
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      serverLogger.warn('Route not found', {
        method: req.method,
        url: req.url,
        ip: req.ip
      });

      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.url} not found`,
        available_endpoints: [
          'GET /',
          'POST /mcp (authenticated)',
        ]
      });
    });

    // Error handler
    this.app.use((error, req, res, next) => {
      const duration = Date.now() - (req.startTime || Date.now());

      serverLogger.error('Express error handler', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        duration: `${duration}ms`,
        userId: req.user?.id
      }, error);

      // CORS errors
      if (error.message.includes('CORS')) {
        return res.status(403).json({
          error: 'CORS Error',
          message: 'Origin not allowed'
        });
      }

      // Generic error response
      res.status(error.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.DEBUG_MODE === 'true' ? error.message : 'An unexpected error occurred',
        request_id: req.requestId
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      serverLogger.error('Uncaught exception', null, error);
      this.shutdown();
    });

    process.on('unhandledRejection', (reason, promise) => {
      serverLogger.error('Unhandled rejection', { promise }, new Error(reason));
      this.shutdown();
    });

    // Handle shutdown signals
    process.on('SIGINT', () => {
      serverLogger.info('Received SIGINT, shutting down gracefully');
      this.shutdown();
    });

    process.on('SIGTERM', () => {
      serverLogger.info('Received SIGTERM, shutting down gracefully');
      this.shutdown();
    });
  }

  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.port, this.host, (error) => {
        if (error) {
          serverLogger.error('Failed to start server', { port: this.port, host: this.host }, error);
          return reject(error);
        }

        serverLogger.info('🚀 Desktop Commander Remote Server started', {
          server: `http://${this.host}:${this.port}`,
          mcp: `http://${this.host}:${this.port}/mcp`,
          environment: process.env.NODE_ENV || 'development'
        });

        this.server = server;
        resolve(server);
      });

      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          serverLogger.error(`Port ${this.port} is already in use`);
        } else {
          serverLogger.error('Server error', null, error);
        }
        reject(error);
      });
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    serverLogger.info('Starting graceful shutdown...');

    try {
      // Close HTTP server
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
      }

      serverLogger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      serverLogger.error('Error during shutdown', null, error);
      process.exit(1);
    }
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new DesktopCommanderRemoteServer();
  server.start().catch((error) => {
    console.error('Failed to start Desktop Commander Remote Server:', error);
    process.exit(1);
  });
}

export default DesktopCommanderRemoteServer;