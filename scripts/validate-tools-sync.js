#!/usr/bin/env node
/**
 * Validates that the tools listed in mcpb-bundle/manifest.json match
 * the tools actually provided by the running MCP server
 * 
 * This uses JSON-RPC to query the server directly, avoiding fragile regex parsing.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

async function extractToolsFromManifest() {
  const manifestPath = join(rootDir, 'mcpb-bundle', 'manifest.json');
  const content = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(content);
  
  return manifest.tools.map(tool => tool.name).sort();
}

async function extractToolsFromServer() {
  return new Promise((resolve, reject) => {
    // Start the MCP server
    const serverPath = join(rootDir, 'dist', 'index.js');
    const server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';
    const messages = [];

    server.stdout.on('data', (data) => {
      output += data.toString();
      
      // Try to parse each line as JSON-RPC message
      const lines = output.split('\n');
      output = lines.pop() || ''; // Keep incomplete line
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            messages.push(JSON.parse(line));
          } catch (e) {
            // Not JSON, might be debug output
          }
        }
      }
    });

    server.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    // Step 1: Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'validate-tools-sync',
          version: '1.0.0'
        }
      }
    };

    server.stdin.write(JSON.stringify(initRequest) + '\n');

    // Wait for initialize response, then send tools/list
    setTimeout(() => {
      // Step 2: Send tools/list request
      const toolsRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      };

      server.stdin.write(JSON.stringify(toolsRequest) + '\n');

      // Wait for tools/list response
      setTimeout(() => {
        server.kill();

        // Find the tools/list response
        const toolsResponse = messages.find(msg => msg.id === 2 && msg.result);

        if (!toolsResponse) {
          reject(new Error('No tools/list response received'));
          return;
        }

        const tools = toolsResponse.result.tools.map(tool => tool.name).sort();
        resolve(tools);
      }, 1000);
    }, 500);

    server.on('error', (error) => {
      reject(new Error(`Failed to start server: ${error.message}`));
    });
  });
}

async function main() {
  console.log(`${colors.cyan}🔍 Validating tool synchronization...${colors.reset}\n`);
  
  try {
    const manifestTools = await extractToolsFromManifest();
    const serverTools = await extractToolsFromServer();
    
    console.log(`${colors.blue}📋 Manifest tools (${manifestTools.length}):${colors.reset}`);
    manifestTools.forEach(tool => console.log(`   - ${tool}`));
    
    console.log(`\n${colors.blue}⚙️  Server tools (${serverTools.length}):${colors.reset}`);
    serverTools.forEach(tool => console.log(`   - ${tool}`));
    
    // Find differences
    const missingInManifest = serverTools.filter(t => !manifestTools.includes(t));
    const missingInServer = manifestTools.filter(t => !serverTools.includes(t));
    
    console.log('\n' + '='.repeat(60));
    
    if (missingInManifest.length === 0 && missingInServer.length === 0) {
      console.log(`${colors.green}✅ SUCCESS: All tools are in sync!${colors.reset}`);
      console.log(`${colors.green}   Both manifest.json and server.ts have ${manifestTools.length} tools.${colors.reset}`);
      process.exit(0);
    } else {
      console.log(`${colors.red}❌ MISMATCH DETECTED!${colors.reset}\n`);
      
      if (missingInManifest.length > 0) {
        console.log(`${colors.yellow}⚠️  Tools in server.ts but NOT in manifest.json:${colors.reset}`);
        missingInManifest.forEach(tool => console.log(`   ${colors.red}✗${colors.reset} ${tool}`));
        console.log();
      }
      
      if (missingInServer.length > 0) {
        console.log(`${colors.yellow}⚠️  Tools in manifest.json but NOT in server.ts:${colors.reset}`);
        missingInServer.forEach(tool => console.log(`   ${colors.red}✗${colors.reset} ${tool}`));
        console.log();
      }
      
      console.log(`${colors.red}Please update the files to match!${colors.reset}`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error(`${colors.red}❌ Error:${colors.reset}`, error.message);
    process.exit(1);
  }
}

main();
