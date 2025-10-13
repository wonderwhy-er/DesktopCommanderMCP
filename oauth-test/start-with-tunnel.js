import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check for flags
const noAuth = process.argv.includes('--no-auth');
const useSDK = process.argv.includes('--sdk');
const useOAuth = process.argv.includes('--oauth');

console.log('🚀 Starting Unified MCP OAuth Server with Cloudflare Tunnel');
if (useSDK) {
  console.log('📦 Using official MCP SDK');
}
if (useOAuth) {
  console.log('🔐 OAuth ENABLED');
} else if (noAuth) {
  console.log('⚠️  Running WITHOUT authentication (testing mode)');
}
console.log('');

// Check if cloudflared is available
const checkCloudflared = spawn('which', ['cloudflared']);

checkCloudflared.on('close', (code) => {
  if (code !== 0) {
    console.error('❌ cloudflared not found');
    console.error('Install with: brew install cloudflare/cloudflare/cloudflared');
    process.exit(1);
  }

  startTunnelFirst();
});

function startTunnelFirst() {
  console.log('🌐 Starting Cloudflare Tunnel first to get URL...');
  console.log('⏳ Waiting for tunnel URL...');
  console.log('');

  // Start cloudflare tunnel first to get the URL
  const tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3000']);

  let tunnelURL = null;
  let server = null;

  tunnel.stdout.on('data', (data) => {
    const output = data.toString();
    process.stdout.write(data);

    // Look for the tunnel URL in cloudflared output
    // Format: https://random-name.trycloudflare.com
    const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    
    if (urlMatch && !tunnelURL) {
      tunnelURL = urlMatch[0];
      console.log('');
      console.log('✅ Tunnel URL detected:', tunnelURL);
      console.log('');
      
      // Now start the server with the correct BASE_URL
      startServerWithURL(tunnelURL);
      server = startServerWithURL(tunnelURL);
    }
  });

  tunnel.stderr.on('data', (data) => {
    const output = data.toString();
    process.stderr.write(data);

    // Also check stderr for the URL
    const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    
    if (urlMatch && !tunnelURL) {
      tunnelURL = urlMatch[0];
      console.log('');
      console.log('✅ Tunnel URL detected:', tunnelURL);
      console.log('');
      
      // Now start the server with the correct BASE_URL
      server = startServerWithURL(tunnelURL);
    }
  });

  tunnel.on('error', (err) => {
    console.error('❌ Tunnel failed to start:', err);
    process.exit(1);
  });

  tunnel.on('close', (code) => {
    console.log('Tunnel closed with code:', code);
    if (server) server.kill();
    process.exit(code);
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('');
    console.log('🛑 Shutting down...');
    tunnel.kill();
    if (server) server.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    tunnel.kill();
    if (server) server.kill();
    process.exit(0);
  });
}

function startServerWithURL(baseURL) {
  console.log('📡 Starting unified server with BASE_URL:', baseURL);
  if (useSDK) {
    console.log('📦 Using MCP SDK server');
  }
  if (useOAuth) {
    console.log('🔐 OAuth ENABLED');
  } else if (noAuth) {
    console.log('⚠️  Authentication DISABLED');
  }
  console.log('');
  
  // Choose which server to start
  let serverFile;
  if (useSDK && useOAuth) {
    serverFile = 'mcp-sdk-oauth-server.js';  // SDK with OAuth
  } else if (useSDK) {
    serverFile = 'mcp-sdk-http-server.js';   // SDK without OAuth
  } else {
    serverFile = 'unified-mcp-server.js';    // Manual implementation
  }
  
  console.log(`   Server file: ${serverFile}`);
  
  // Start the server
  const server = spawn('node', [serverFile], {
    cwd: __dirname,
    env: {
      ...process.env,
      BASE_URL: baseURL,
      PORT: '3000',
      REQUIRE_AUTH: (noAuth || !useOAuth) ? 'false' : 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  server.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  server.on('error', (err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  });

  server.on('close', (code) => {
    console.log('Server closed with code:', code);
  });

  return server;
}
