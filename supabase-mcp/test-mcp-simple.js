#!/usr/bin/env node

/**
 * Simple MCP test script without OAuth
 */

import fetch from 'node-fetch';

const MCP_URL = 'http://localhost:3007/mcp-test';

async function testMCP() {
    console.log('🧪 Testing MCP server without OAuth...\n');

    // Test 1: List tools
    console.log('1. Testing tools/list...');
    const listResponse = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
        })
    });
    const listResult = await listResponse.json();
    console.log('✅ Tools:', listResult.result?.tools?.map(t => t.name) || 'No tools');
    console.log();

    // Test 2: Echo tool
    console.log('2. Testing echo tool...');
    const echoResponse = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'echo',
                arguments: {
                    text: 'Hello MCP!',
                    uppercase: true
                }
            }
        })
    });
    const echoResult = await echoResponse.json();
    console.log('✅ Echo result:', echoResult.result?.content?.[0]?.text || echoResult.error?.message || 'No result');
    console.log();

    // Test 3: Agent status
    console.log('3. Testing agent_status...');
    const statusResponse = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
                name: 'agent_status',
                arguments: {}
            }
        })
    });
    const statusResult = await statusResponse.json();
    console.log('✅ Agent status:', statusResult.result?.content?.[0]?.text || statusResult.error?.message || 'No agents');
    console.log();

    // Test 4: Remote echo (will fail if no agents)
    console.log('4. Testing remote_echo...');
    const remoteResponse = await fetch(MCP_URL, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
                name: 'remote_echo',
                arguments: {
                    text: 'Test remote execution'
                }
            }
        })
    });
    const remoteResult = await remoteResponse.json();
    console.log('✅ Remote echo:', remoteResult.error?.message || remoteResult.result || 'Success');
}

testMCP().catch(console.error);