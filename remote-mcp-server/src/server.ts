import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import path from 'path';

import { db } from './database/connection';
import { runMigrations } from './database/migrate';
import { WebSocketManager } from './websocket/manager';
import { SSEManager } from './sse/manager';
import { createSSERouter } from './sse/routes';
import authRoutes from './auth/routes';
import deviceRoutes from './device/routes';
import { createMCPRouter } from './mcp/routes';

// Load environment variables
dotenv.config();

const app = express();
const server = createServer(app);
const port = process.env.PORT || 3001;

// Initialize WebSocket manager and SSE manager
const wsManager = new WebSocketManager();
const sseManager = new SSEManager();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://yourdomain.com'] 
    : ['http://localhost:3001', 'http://localhost:3000'],
  credentials: true
}));

app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    connections: wsManager.getConnectionCount(),
    sseConnections: sseManager.getConnectionCount(),
    pendingRequests: 0 // We could track this if needed
  });
});

// API Routes
app.use('/auth', authRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/mcp', createMCPRouter(wsManager, sseManager));

// SSE Routes
app.use('/', createSSERouter(sseManager));

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, '../public')));

// Fallback to index.html for SPA routing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

// Error handling middleware
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: error.message })
  });
});

// WebSocket Server
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

wss.on('connection', (ws, req) => {
  wsManager.handleConnection(ws, req.url || '');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    db.close().then(() => {
      process.exit(0);
    });
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    db.close().then(() => {
      process.exit(0);
    });
  });
});

// Start server
async function startServer() {
  try {
    // Test database connection
    console.log('Testing database connection...');
    const dbConnected = await db.testConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed');
    }
    
    // Run migrations
    console.log('Running database migrations...');
    await runMigrations();
    
    // Start HTTP server
    server.listen(port, () => {
      console.log(`🚀 Remote MCP Server running on port ${port}`);
      console.log(`📊 Dashboard: http://localhost:${port}`);
      console.log(`🔌 WebSocket: ws://localhost:${port}/ws`);
      console.log(`💾 Database: ${process.env.POSTGRES_URL?.split('@')[1]}`);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();