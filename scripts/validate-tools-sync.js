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
import { listModelVisibleServerTools } from './model-tools-client.mjs';

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
  // A source checkout contains the template; a packaged build contains manifest.json.
  let content;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    content = await readFile(join(rootDir, 'manifest.template.json'), 'utf-8');
  }
  const manifest = JSON.parse(content);
  
  return manifest.tools.map(tool => tool.name).sort();
}

async function extractToolsFromServer() {
  return listModelVisibleServerTools(join(rootDir, 'dist', 'index.js'));
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
