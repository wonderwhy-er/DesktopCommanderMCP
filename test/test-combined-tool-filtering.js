#!/usr/bin/env node
/**
 * Test: Combined tool filtering behavior
 * - When client is "desktop-commander", feedback tool should be hidden.
 * - When skillsEnabled=false, skill tools should be hidden.
 *
 * This test uses a real MCP client connection to exercise initialize + tools/list.
 */

import assert from 'assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configManager } from '../dist/config-manager.js';

const SKILL_TOOLS = new Set([
  'list_skills',
  'get_skill',
  'run_skill',
  'get_skill_run',
  'cancel_skill_run',
  'approve_skill_run'
]);

async function run() {
  console.log('\n=== Test: Combined Tool Filtering ===\n');

  let client;
  let prevSkillsEnabled;
  try {
    // Configure before server startup because the server keeps an in-memory config.
    // This test validates tool filtering behavior, not cross-process hot-reload semantics.
    prevSkillsEnabled = await configManager.getValue('skillsEnabled');
    await configManager.setValue('skillsEnabled', false);

    client = new Client(
      { name: 'desktop-commander', version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['../dist/index.js']
    });

    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    assert.ok(
      !toolNames.includes('give_feedback_to_desktop_commander'),
      'give_feedback_to_desktop_commander should be hidden for desktop-commander client'
    );

    for (const toolName of toolNames) {
      assert.ok(
        !SKILL_TOOLS.has(toolName),
        `Skill tool ${toolName} should be hidden when skillsEnabled=false`
      );
    }

    console.log('test-combined-tool-filtering: PASS');
  } finally {
    // Best-effort restore; tests should not leave config mutated.
    if (prevSkillsEnabled !== undefined) {
      try {
        await configManager.setValue('skillsEnabled', prevSkillsEnabled);
      } catch {
        // ignore
      }
    }
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }
}

run().catch((error) => {
  console.error('test-combined-tool-filtering: FAIL', error);
  process.exit(1);
});
