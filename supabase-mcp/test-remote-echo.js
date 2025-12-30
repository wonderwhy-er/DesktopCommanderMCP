#!/usr/bin/env node

/**
 * Test script for remote_echo tool call
 * This script will directly call the remote_echo tool to test the enhanced logging
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3007';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || 'test-token';

async function testRemoteEcho() {
    console.log('🧪 Testing remote_echo tool call...');
    console.log(`Server URL: ${MCP_SERVER_URL}`);
    console.log(`Using access token: ${ACCESS_TOKEN.substring(0, 10)}...`);
    
    const request = {
        jsonrpc: '2.0',
        id: 'test-remote-echo-' + Date.now(),
        method: 'tools/call',
        params: {
            name: 'remote_echo',
            arguments: {
                text: 'Hello from test script - testing remote execution!'
            }
        }
    };
    
    console.log('🚀 Sending tool call request:', JSON.stringify(request, null, 2));
    
    try {
        const response = await fetch(`${MCP_SERVER_URL}/mcp-direct`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Accept': 'application/json'
            },
            body: JSON.stringify(request),
            timeout: 30000
        });
        
        console.log(`📡 Response status: ${response.status}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ HTTP Error: ${errorText}`);
            return;
        }
        
        const responseData = await response.json();
        console.log('✅ Response received:', JSON.stringify(responseData, null, 2));
        
        if (responseData.error) {
            console.error('❌ MCP Error:', responseData.error);
        } else {
            console.log('🎉 Tool call successful!');
            console.log('📝 Result:', responseData.result);
        }
        
    } catch (error) {
        console.error('❌ Request failed:', error.message);
    }
}

// Run the test
testRemoteEcho().catch(console.error);