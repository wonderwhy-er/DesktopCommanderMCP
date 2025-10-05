#!/usr/bin/env node
/**
 * Test: Verify conditional tool registration based on client name
 * Tests that give_feedback_to_desktop_commander is excluded for desktop-commander client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function testConditionalTools() {
    console.log('\n=== Test: Conditional Tool Registration ===\n');

    // Test 1: Regular client (should include feedback tool)
    console.log('Test 1: Testing with regular client (should include feedback tool)...');
    const regularClient = new Client(
        {
            name: "test-client",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    const regularTransport = new StdioClientTransport({
        command: "node",
        args: ["../dist/index.js"]
    });

    await regularClient.connect(regularTransport);
    const regularTools = await regularClient.listTools();

    const hasFeedbackRegular = regularTools.tools.some(t => t.name === 'give_feedback_to_desktop_commander');
    console.log(`   Tools count: ${regularTools.tools.length}`);
    console.log(`   Has give_feedback_to_desktop_commander: ${hasFeedbackRegular}`);

    if (hasFeedbackRegular) {
        console.log('   ✅ PASS: Feedback tool is included for regular client');
    } else {
        console.log('   ❌ FAIL: Feedback tool should be included for regular client');
        process.exit(1);
    }

    await regularClient.close();

    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: desktop-commander client (should exclude feedback tool)
    console.log('\nTest 2: Testing with desktop-commander client (should exclude feedback tool)...');
    const dcClient = new Client(
        {
            name: "desktop-commander",
            version: "1.0.0"
        },
        {
            capabilities: {}
        }
    );

    const dcTransport = new StdioClientTransport({
        command: "node",
        args: ["../dist/index.js"]
    });

    await dcClient.connect(dcTransport);
    const dcTools = await dcClient.listTools();

    const hasFeedbackDC = dcTools.tools.some(t => t.name === 'give_feedback_to_desktop_commander');
    console.log(`   Tools count: ${dcTools.tools.length}`);
    console.log(`   Has give_feedback_to_desktop_commander: ${hasFeedbackDC}`);

    if (!hasFeedbackDC) {
        console.log('   ✅ PASS: Feedback tool is excluded for desktop-commander client');
    } else {
        console.log('   ❌ FAIL: Feedback tool should be excluded for desktop-commander client');
        process.exit(1);
    }

    await dcClient.close();

    console.log('\n=== All Tests Passed! ===\n');
}

testConditionalTools().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
