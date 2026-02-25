#!/usr/bin/env node
/**
 * Count tokens consumed by Desktop Commander MCP tool definitions.
 * 
 * Spawns the MCP server, queries tools/list via JSON-RPC,
 * then uses js-tiktoken (cl100k_base) to count tokens per tool.
 * 
 * Usage: npm run count-tokens
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { encodingForModel } from 'js-tiktoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function extractToolsFromServer() {
  return new Promise((resolve, reject) => {
    const serverPath = join(rootDir, 'dist', 'index.js');
    const server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME },
    });

    let output = '';
    const messages = [];

    server.stdout.on('data', (data) => {
      output += data.toString();
      const lines = output.split('\n');
      output = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try { messages.push(JSON.parse(line)); } catch {}
        }
      }
    });

    server.stderr.on('data', () => {}); // silence

    const initRequest = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'count-tokens', version: '1.0.0' },
      },
    };
    server.stdin.write(JSON.stringify(initRequest) + '\n');

    setTimeout(() => {
      const toolsRequest = {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      };
      server.stdin.write(JSON.stringify(toolsRequest) + '\n');

      setTimeout(() => {
        server.kill();
        const resp = messages.find((m) => m.id === 2 && m.result);
        if (!resp) return reject(new Error('No tools/list response'));
        resolve(resp.result.tools);
      }, 1500);
    }, 500);

    server.on('error', (e) => reject(e));
  });
}

function countTokens(enc, text) {
  return enc.encode(text).length;
}

function tokenizeToolDefinition(enc, tool) {
  // Approximate how an MCP client serializes a tool for the LLM context.
  // Most clients send the full JSON schema including name, description, inputSchema.
  const serialized = JSON.stringify(tool);
  return {
    total: countTokens(enc, serialized),
    name: countTokens(enc, tool.name || ''),
    description: countTokens(enc, tool.description || ''),
    schema: countTokens(enc, JSON.stringify(tool.inputSchema || {})),
  };
}

async function main() {
  const flag = process.argv[2]; // --json or --top or nothing
  const isJson = flag === '--json';

  if (!isJson) {
    console.log(`${colors.cyan}🔢 Desktop Commander MCP — Token Counter${colors.reset}`);
    console.log(`${colors.dim}   Using cl100k_base tokenizer (GPT-4 / Claude approximation)${colors.reset}\n`);

    console.log(`${colors.dim}   Starting server and querying tools/list...${colors.reset}`);
  }

  const tools = await extractToolsFromServer();

  if (!isJson) {
    console.log(`${colors.green}   ✓ Retrieved ${tools.length} tools${colors.reset}\n`);
  }

  const enc = encodingForModel('gpt-4');

  const results = tools.map((tool) => {
    const tokens = tokenizeToolDefinition(enc, tool);
    return { toolName: String(tool.name || 'unknown'), ...tokens };
  });

  // Sort by total tokens descending
  results.sort((a, b) => b.total - a.total);

  const grandTotal = results.reduce((s, r) => s + r.total, 0);
  const descTotal = results.reduce((s, r) => s + r.description, 0);
  const schemaTotal = results.reduce((s, r) => s + r.schema, 0);

  if (!isJson) {
    // --- Summary ---
    console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bold}  SUMMARY${colors.reset}`);
    console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`  Tools count:        ${colors.bold}${tools.length}${colors.reset}`);
    console.log(`  Total tokens:       ${colors.bold}${grandTotal.toLocaleString()}${colors.reset}`);
    console.log(`  ├─ Descriptions:    ${descTotal.toLocaleString()} (${pct(descTotal, grandTotal)})`);
    console.log(`  └─ Schemas:         ${schemaTotal.toLocaleString()} (${pct(schemaTotal, grandTotal)})`);

    console.log(`  Context window usage (200K): ${colors.yellow}${pct(grandTotal, 200000)}${colors.reset}`);
    console.log();

    // --- Per-tool table ---
    console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bold}  PER-TOOL BREAKDOWN (sorted by total tokens)${colors.reset}`);
    console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(
      `  ${'#'.padEnd(3)} ${'Tool Name'.padEnd(35)} ${'Total'.padStart(7)} ${'Desc'.padStart(7)} ${'Schema'.padStart(7)} ${'Bar'}`
    );
    console.log(`  ${'-'.repeat(75)}`);

    const maxTokens = results[0]?.total || 1;
    results.forEach((r, i) => {
      const barLen = Math.round((r.total / maxTokens) * 30);
      const bar = '█'.repeat(barLen) + '░'.repeat(30 - barLen);
      const color = r.total > 500 ? colors.yellow : colors.dim;
      console.log(
        `  ${String(i + 1).padEnd(3)} ${color}${r.toolName.padEnd(35)}${colors.reset} ${String(r.total).padStart(7)} ${String(r.description).padStart(7)} ${String(r.schema).padStart(7)} ${colors.dim}${bar}${colors.reset}`
      );
    });

    console.log();

    // --- Category breakdown ---
    const categories = categorize(results);
    console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bold}  BY CATEGORY${colors.reset}`);
    console.log(`${colors.bold}═══════════════════════════════════════════════════════════════${colors.reset}`);

    for (const [cat, catResults] of Object.entries(categories)) {
      const catTotal = catResults.reduce((s, r) => s + r.total, 0);
      console.log(
        `  ${cat.padEnd(25)} ${String(catResults.length).padStart(3)} tools  ${String(catTotal).padStart(7)} tokens  (${pct(catTotal, grandTotal)})`
      );
    }
    console.log();
  }

  // --- JSON output ---
  if (isJson) {
    const output = {
      timestamp: new Date().toISOString(),
      toolCount: tools.length,
      totalTokens: grandTotal,
      descriptionTokens: descTotal,
      schemaTokens: schemaTotal,
      contextWindowPct: (grandTotal / 200000 * 100).toFixed(2),
      tools: results,
    };
    console.log(JSON.stringify(output, null, 2));
  }

  // enc cleanup not needed for js-tiktoken
}

function pct(part, whole) {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function categorize(results) {
  const cats = {};
  for (const r of results) {
    let cat;
    if (r.toolName.startsWith('macos_ax_')) cat = 'macOS AX';
    else if (r.toolName.startsWith('electron_debug_')) cat = 'Electron Debug';
    else if (['read_file', 'read_multiple_files', 'write_file', 'write_pdf', 'edit_block', 'create_directory', 'move_file', 'list_directory', 'get_file_info'].includes(r.toolName)) cat = 'Filesystem';
    else if (['start_search', 'get_more_search_results', 'stop_search', 'list_searches'].includes(r.toolName)) cat = 'Search';
    else if (['start_process', 'interact_with_process', 'read_process_output', 'force_terminate', 'list_sessions'].includes(r.toolName)) cat = 'Process/Terminal';
    else if (['list_processes', 'kill_process'].includes(r.toolName)) cat = 'OS Processes';
    else if (['get_config', 'set_config_value'].includes(r.toolName)) cat = 'Configuration';
    else cat = 'Other';
    (cats[cat] ??= []).push(r);
  }
  return cats;
}

main().catch((e) => {
  console.error(`${colors.red}❌ ${e.message}${colors.reset}`);
  process.exit(1);
});
