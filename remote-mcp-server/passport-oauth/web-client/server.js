#!/usr/bin/env node

/**
 * Simple HTTP Server for MCP Web Client
 * Serves the web client files and handles static content
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class WebClientServer {
    constructor() {
        this.app = express();
        this.port = parseInt(process.env.WEB_CLIENT_PORT) || 8847;
        this.host = process.env.WEB_CLIENT_HOST || 'localhost';
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        // CORS for cross-origin requests
        this.app.use(cors({
            origin: true,
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
        }));

        // Security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'SAMEORIGIN');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            next();
        });

        // Request logging
        this.app.use((req, res, next) => {
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
            next();
        });
    }

    setupRoutes() {
        // Serve static files
        this.app.use(express.static(__dirname, {
            setHeaders: (res, path, stat) => {
                // Set correct MIME types
                if (path.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript');
                } else if (path.endsWith('.html')) {
                    res.setHeader('Content-Type', 'text/html');
                }
            }
        }));

        // Main page
        this.app.get('/', (req, res) => {
            res.sendFile(join(__dirname, 'index.html'));
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                service: 'MCP Web Client Server',
                version: '1.0.0',
                timestamp: new Date().toISOString()
            });
        });

        // 404 handler
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'not_found',
                message: `Path ${req.path} not found`,
                available_paths: [
                    '/',
                    '/health'
                ]
            });
        });
    }

    start() {
        const server = this.app.listen(this.port, this.host, () => {
            console.log(`🌐 MCP Web Client Server started`);
            console.log(`📡 Server: http://${this.host}:${this.port}`);
            console.log(`🎯 Main App: http://${this.host}:${this.port}/`);
            console.log(`📋 Health: http://${this.host}:${this.port}/health`);
            console.log(`✅ Ready to serve MCP web client!`);
        });

        // Graceful shutdown
        const gracefulShutdown = () => {
            console.log('\\n🛑 Shutting down web client server...');
            server.close(() => {
                console.log('✅ Web client server closed');
                process.exit(0);
            });
        };

        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

        return server;
    }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const server = new WebClientServer();
    server.start();
}

export default WebClientServer;