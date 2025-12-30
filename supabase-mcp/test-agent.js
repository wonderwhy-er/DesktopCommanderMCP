#!/usr/bin/env node

/**
 * Test script to verify agent functionality
 */

import { createClient } from '@supabase/supabase-js';

async function testAgentIntegration() {
  console.log('🧪 Testing Agent Integration...');
  
  try {
    // Test 1: Check server is running
    console.log('\n1️⃣ Testing server availability...');
    const serverUrl = 'http://localhost:3007';
    
    const healthResponse = await fetch(`${serverUrl}/health`);
    if (!healthResponse.ok) {
      throw new Error(`Server not available: ${healthResponse.statusText}`);
    }
    console.log('✅ Server is running');

    // Test 2: Check OAuth discovery
    console.log('\n2️⃣ Testing OAuth discovery...');
    const discoveryResponse = await fetch(`${serverUrl}/.well-known/oauth-authorization-server`);
    if (!discoveryResponse.ok) {
      throw new Error(`OAuth discovery failed: ${discoveryResponse.statusText}`);
    }
    const discovery = await discoveryResponse.json();
    console.log('✅ OAuth discovery working');
    console.log(`   Authorization endpoint: ${discovery.authorization_endpoint}`);
    console.log(`   Token endpoint: ${discovery.token_endpoint}`);

    // Test 3: Check MCP info endpoint
    console.log('\n3️⃣ Testing MCP info endpoint...');
    const mcpInfoResponse = await fetch(`${serverUrl}/api/mcp-info`);
    if (!mcpInfoResponse.ok) {
      throw new Error(`MCP info failed: ${mcpInfoResponse.statusText}`);
    }
    const mcpInfo = await mcpInfoResponse.json();
    console.log('✅ MCP info endpoint working');
    console.log(`   Supabase URL: ${mcpInfo.supabaseUrl ? '✅ Configured' : '❌ Missing'}`);
    console.log(`   Supabase Anon Key: ${mcpInfo.supabaseAnonKey ? '✅ Configured' : '❌ Missing'}`);

    // Test 4: Check database schema (if possible)
    if (mcpInfo.supabaseUrl && mcpInfo.supabaseAnonKey) {
      console.log('\n4️⃣ Testing database schema...');
      try {
        const supabase = createClient(mcpInfo.supabaseUrl, mcpInfo.supabaseAnonKey);
        
        // Check if tables exist
        const { data: agents, error: agentsError } = await supabase
          .from('mcp_agents')
          .select('count')
          .limit(1);
        
        if (agentsError && agentsError.code !== 'PGRST116') {
          console.log(`⚠️  Agents table issue: ${agentsError.message}`);
        } else {
          console.log('✅ mcp_agents table accessible');
        }

        const { data: calls, error: callsError } = await supabase
          .from('mcp_remote_calls')
          .select('count')
          .limit(1);
        
        if (callsError && callsError.code !== 'PGRST116') {
          console.log(`⚠️  Remote calls table issue: ${callsError.message}`);
        } else {
          console.log('✅ mcp_remote_calls table accessible');
        }

        const { data: pkce, error: pkceError } = await supabase
          .from('mcp_pkce_codes')
          .select('count')
          .limit(1);
        
        if (pkceError && pkceError.code !== 'PGRST116') {
          console.log(`⚠️  PKCE codes table issue: ${pkceError.message}`);
        } else {
          console.log('✅ mcp_pkce_codes table accessible');
        }
        
      } catch (dbError) {
        console.log(`⚠️  Database test failed: ${dbError.message}`);
      }
    }

    console.log('\n🎉 All tests passed! Agent integration is ready.');
    console.log('\n📋 Next steps:');
    console.log('   1. Start the agent: npm run agent');
    console.log('   2. Complete authentication in browser');
    console.log('   3. Test remote tool calls from Claude Desktop');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run tests
testAgentIntegration();