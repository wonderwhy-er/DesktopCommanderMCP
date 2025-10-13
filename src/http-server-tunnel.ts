#!/usr/bin/env node
import { spawn, ChildProcess } from 'child_process';

console.log('🚀 Starting Desktop Commander HTTP Server with Cloudflare Tunnel');
console.log('');

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

  startTunnel();
});

function startTunnel() {
  console.log('🌐 Starting Cloudflare Tunnel...');
  console.log('⏳ Waiting for tunnel URL...');
  console.log('');

  // Start cloudflare tunnel
  const tunnel = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:3000']);

  let tunnelURL: string | null = null;
  let server: ChildProcess | null = null;

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
      
      // Now start the server with the correct BASE_URL (tunnelURL is guaranteed to be non-null here)
      server = startServer(tunnelURL!);
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
      
      // Now start the server with the correct BASE_URL (tunnelURL is guaranteed to be non-null here)
      server = startServer(tunnelURL!);
    }
  });

  tunnel.on('error', (err) => {
    console.error('❌ Tunnel failed to start:', err);
    process.exit(1);
  });

  tunnel.on('close', (code) => {
    console.log('');
    console.log('🔴 Tunnel closed with code:', code);
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

function startServer(baseURL: string): ChildProcess {
  console.log('📡 Starting Desktop Commander HTTP server with BASE_URL:', baseURL);
  console.log('');
  
  // Start the http-server with the tunnel URL
  const server = spawn('node', ['dist/http-server.js'], {
    env: {
      ...process.env,
      BASE_URL: baseURL,
      PORT: '3000'
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
