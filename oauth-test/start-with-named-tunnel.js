#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'desktop-commander';
const TUNNEL_URL = process.env.TUNNEL_URL || 'https://mcp.desktopcommander.app';
const PORT = process.env.PORT || 3000;
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== 'false'; // Default to true

console.log('🚀 Starting OAuth Test Server with Named Cloudflare Tunnel');
console.log(`   Tunnel Name: ${TUNNEL_NAME}`);
console.log(`   Tunnel URL: ${TUNNEL_URL}`);
console.log(`   Port: ${PORT}`);
console.log(`   Auth: ${REQUIRE_AUTH ? 'ENABLED' : 'DISABLED'}`);
console.log('');

// Check if tunnel exists
console.log('🔍 Checking for existing tunnel...');
const checkTunnel = spawn('cloudflared', ['tunnel', 'info', TUNNEL_NAME]);

checkTunnel.on('close', (code) => {
  if (code === 0) {
    console.log(`✅ Found tunnel: ${TUNNEL_NAME}`);
    console.log(`   URL: ${TUNNEL_URL}`);
    console.log('');
    startServer();
  } else {
    console.error(`❌ Tunnel "${TUNNEL_NAME}" not found`);
    console.error('');
    console.error('Create a named tunnel first:');
    console.error(`   cloudflared tunnel create ${TUNNEL_NAME}`);
    console.error(`   cloudflared tunnel route dns ${TUNNEL_NAME} mcp.desktopcommander.app`);
    console.error('');
    console.error('Or set a different tunnel name:');
    console.error(`   TUNNEL_NAME=your-tunnel npm run tunnel-sdk-named`);
    process.exit(1);
  }
});

function startServer() {
  console.log('📡 Starting OAuth Test Server...');
  
  // Start the MCP SDK OAuth server
  const server = spawn('node', ['mcp-sdk-oauth-server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      BASE_URL: TUNNEL_URL,
      PORT: PORT.toString(),
      REQUIRE_AUTH: REQUIRE_AUTH ? 'true' : 'false'
    },
    stdio: 'inherit'
  });

  server.on('error', (err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
  });

  server.on('close', (code) => {
    console.log(`🔴 Server closed with code: ${code}`);
    process.exit(code || 0);
  });

  // Start the tunnel
  console.log('');
  console.log('🌐 Starting named Cloudflare Tunnel...');
  console.log(`   Tunnel name: ${TUNNEL_NAME}`);
  console.log(`   Public URL: ${TUNNEL_URL}`);
  console.log('');

  const tunnel = spawn('cloudflared', [
    'tunnel',
    '--config', '/dev/null',
    'run',
    '--url', `http://localhost:${PORT}`,
    TUNNEL_NAME
  ], {
    stdio: 'inherit'
  });

  tunnel.on('error', (err) => {
    console.error('❌ Tunnel failed to start:', err);
    server.kill();
    process.exit(1);
  });

  tunnel.on('close', (code) => {
    console.log(`Tunnel closed with code: ${code}`);
    server.kill();
    process.exit(code || 0);
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    console.log('');
    console.log('🛑 Shutting down...');
    tunnel.kill();
    server.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    tunnel.kill();
    server.kill();
    process.exit(0);
  });
}
