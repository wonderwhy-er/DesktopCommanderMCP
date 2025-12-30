#!/usr/bin/env node

/**
 * Web Authentication Interface for Supabase MCP Server
 * 
 * Provides simple signup/signin web interface for users to authenticate
 * and obtain access tokens for MCP server access.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { webLogger } from '../utils/logger.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WebAuthServer {
  constructor() {
    this.app = express();
    this.port = parseInt(process.env.WEB_SERVER_PORT) || 3008;
    this.host = process.env.MCP_SERVER_HOST || 'localhost';
    this.mcpServerUrl = `http://${this.host}:${process.env.MCP_SERVER_PORT || 3007}`;
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
    
    webLogger.info('Web Auth Server initialized', {
      port: this.port,
      host: this.host,
      mcpServerUrl: this.mcpServerUrl
    });
  }
  
  setupMiddleware() {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, 'public')));
    
    // Request logging
    this.app.use((req, res, next) => {
      webLogger.logRequest(req);
      next();
    });
    
    // Basic security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });
  }
  
  setupRoutes() {
    // Root - redirect to auth page
    this.app.get('/', (req, res) => {
      res.redirect('/auth.html');
    });
    
    // Auth callback - handle successful authentication
    this.app.get('/auth/callback', (req, res) => {
      const { access_token, refresh_token, error, error_description } = req.query;
      
      if (error) {
        webLogger.warn('Auth callback error', { error, error_description });
        return res.redirect(`/auth.html?error=${encodeURIComponent(error_description || error)}`);
      }
      
      if (access_token) {
        webLogger.info('Auth callback success');
        return res.redirect(`/success.html?token=${encodeURIComponent(access_token)}&refresh=${encodeURIComponent(refresh_token || '')}`);
      }
      
      webLogger.warn('Auth callback - no token received');
      res.redirect('/auth.html?error=No access token received');
    });
    
    // API endpoint to get MCP server info
    this.app.get('/api/mcp-info', (req, res) => {
      res.json({
        mcpServerUrl: this.mcpServerUrl,
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
        redirectUrl: process.env.OAUTH_REDIRECT_URL || `http://${this.host}:${this.port}/auth/callback`
      });
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        service: 'supabase-mcp-web-auth',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      });
    });
  }
  
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      webLogger.warn('Route not found', { url: req.url });
      res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Page Not Found</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            .error { color: #dc3545; }
          </style>
        </head>
        <body>
          <h1 class="error">404 - Page Not Found</h1>
          <p>The requested page could not be found.</p>
          <a href="/auth.html">← Back to Authentication</a>
        </body>
        </html>
      `);
    });
    
    // Error handler
    this.app.use((error, req, res, next) => {
      webLogger.error('Web server error', { url: req.url }, error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Server Error</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            .error { color: #dc3545; }
          </style>
        </head>
        <body>
          <h1 class="error">500 - Server Error</h1>
          <p>An unexpected error occurred.</p>
          <a href="/auth.html">← Back to Authentication</a>
        </body>
        </html>
      `);
    });
  }
  
  async start() {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.port, this.host, (error) => {
        if (error) {
          webLogger.error('Failed to start web server', { port: this.port }, error);
          return reject(error);
        }
        
        webLogger.info('🌐 Web Auth Server started', {
          server: `http://${this.host}:${this.port}`,
          auth: `http://${this.host}:${this.port}/auth.html`,
          health: `http://${this.host}:${this.port}/health`
        });
        
        resolve(server);
      });
    });
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new WebAuthServer();
  server.start().catch((error) => {
    console.error('Failed to start Web Auth Server:', error);
    process.exit(1);
  });
}

export default WebAuthServer;