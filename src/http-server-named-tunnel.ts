#!/usr/bin/env node
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

console.log('🚀 Starting Desktop Commander with Named Cloudflare Tunnel');
console.log('');

// Configuration - can be overridden with environment variables
const TUNNEL_NAME = process.env.TUNNEL_NAME || 'desktop-commander';
const TUNNEL_URL = process.env.TUNNEL_URL; // Must be provided if tunnel exists
const PORT = process.env.PORT || '3000';

// Check if cloudflared is available
const checkCloudflared = spawn('which', ['cloudflared']);

checkCloudflared.on('close', (code) => {
  if (code !== 0) {
    console.error('❌ cloudflared not found');
    console.error('');
    console.error('📦 Install cloudflared:');
    console.error('   macOS:   brew install cloudflare/cloudflare/cloudflared');
    console.error('   Linux:   https://github.com/cloudflare/cloudflared');
    console.error('   Windows: https://github.com/cloudflare/cloudflared');
    console.error('');
    process.exit(1);
  }

  checkTunnelExists();
});

function checkTunnelExists() {
  console.log('🔍 Checking for existing tunnel...');
  
  // List existing tunnels
  const listTunnels = spawn('cloudflared', ['tunnel', 'list']);
  let output = '';

  listTunnels.stdout.on('data', (data) => {
    output += data.toString();
  });

  listTunnels.stderr.on('data', (data) => {
    // Ignore stderr for now
  });

  listTunnels.on('close', (code) => {
    if (code !== 0) {
      console.error('❌ Failed to list tunnels. Make sure you are logged in:');
      console.error('   Run: cloudflared tunnel login');
      console.error('');
      process.exit(1);
    }

    // Check if tunnel exists
    const tunnelExists = output.includes(TUNNEL_NAME);

    if (!tunnelExists) {
      console.log(`❌ Tunnel "${TUNNEL_NAME}" not found`);
      console.log('');
      console.log('📝 Setup Instructions:');
      console.log('');
      console.log('1️⃣  Login to Cloudflare:');
      console.log('   cloudflared tunnel login');
      console.log('');
      console.log('2️⃣  Create the tunnel:');
      console.log(`   cloudflared tunnel create ${TUNNEL_NAME}`);
      console.log('');
      console.log('3️⃣  Get the tunnel credentials:');
      console.log('   - Note the Tunnel ID from the output');
      console.log(`   - Find credentials at: ~/.cloudflared/<TUNNEL-ID>.json`);
      console.log('');
      console.log('4️⃣  Create config file at ~/.cloudflared/config.yml:');
      console.log('   tunnel: <YOUR-TUNNEL-ID>');
      console.log('   credentials-file: ~/.cloudflared/<YOUR-TUNNEL-ID>.json');
      console.log('   ingress:');
      console.log(`     - hostname: dc.yourdomain.com  # Your domain or use *.trycloudflare.com`);
      console.log(`     - service: http://localhost:${PORT}`);
      console.log('     - service: http_status:404');
      console.log('');
      console.log('5️⃣  (Optional) Route DNS if using custom domain:');
      console.log(`   cloudflared tunnel route dns ${TUNNEL_NAME} dc.yourdomain.com`);
      console.log('');
      console.log('6️⃣  Set your tunnel URL and run:');
      console.log('   export TUNNEL_URL=https://dc.yourdomain.com');
      console.log(`   npm run start:named-tunnel`);
      console.log('');
      process.exit(1);
    }

    if (!TUNNEL_URL) {
      console.error('❌ TUNNEL_URL environment variable not set');
      console.error('');
      console.error('Set your stable tunnel URL:');
      console.error('   export TUNNEL_URL=https://your-tunnel-url.com');
      console.error(`   npm run start:named-tunnel`);
      console.error('');
      console.error('Or check your config at ~/.cloudflared/config.yml for the hostname');
      console.error('');
      process.exit(1);
    }

    console.log(`✅ Found tunnel: ${TUNNEL_NAME}`);
    console.log(`   URL: ${TUNNEL_URL}`);
    console.log('');
    
    startNamedTunnel();
  });
}

function startNamedTunnel() {
  // Start the HTTP server first with the known URL
  console.log('📡 Starting Desktop Commander HTTP server...');
  const server = startServer(TUNNEL_URL!);

  // Give server a moment to start
  setTimeout(() => {
    console.log('');
    console.log('🌐 Starting named Cloudflare Tunnel...');
    console.log(`   Tunnel name: ${TUNNEL_NAME}`);
    console.log(`   Public URL: ${TUNNEL_URL}`);
    console.log('');
    
    const tunnel = spawn('cloudflared', ['tunnel', 'run', TUNNEL_NAME]);

    tunnel.stdout.on('data', (data) => {
      process.stdout.write(data);
    });

    tunnel.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    tunnel.on('error', (err) => {
      console.error('❌ Tunnel failed to start:', err);
      console.error('');
      console.error('Troubleshooting:');
      console.error('1. Check config file: ~/.cloudflared/config.yml');
      console.error('2. Verify credentials file exists');
      console.error(`3. Try: cloudflared tunnel info ${TUNNEL_NAME}`);
      console.error('');
      server.kill();
      process.exit(1);
    });

    tunnel.on('close', (code) => {
      console.log('');
      console.log('🔴 Tunnel closed with code:', code);
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
  }, 1000); // Wait 1 second for server to initialize
}

function startServer(baseURL: string): ChildProcess {
  const server = spawn('node', ['dist/http-server.js'], {
    env: {
      ...process.env,
      BASE_URL: baseURL,
      PORT: PORT
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
    console.log('');
    console.log('🔴 Server closed with code:', code);
  });

  return server;
}
