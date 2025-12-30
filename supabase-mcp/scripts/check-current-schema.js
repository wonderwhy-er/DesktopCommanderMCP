#!/usr/bin/env node

/**
 * Check current database schema
 */

import { createSupabaseClient } from '../src/utils/supabase.js';

async function checkCurrentSchema() {
  const supabase = createSupabaseClient();
  
  console.log('📊 Checking current database schema...');
  console.log('');
  
  try {
    // Get current tables
    const { data: tables, error: tablesError } = await supabase
      .rpc('get_public_tables');
      
    if (tablesError) {
      console.log('⚠️  Could not fetch tables via RPC, trying direct query...');
      
      // Alternative: check specific tables we care about
      const testQueries = [
        { name: 'auth.users', query: 'SELECT COUNT(*) FROM auth.users' },
        { name: 'mcp_sessions', query: 'SELECT COUNT(*) FROM mcp_sessions' },
        { name: 'mcp_pkce_codes', query: 'SELECT COUNT(*) FROM mcp_pkce_codes' },
        { name: 'mcp_agents', query: 'SELECT COUNT(*) FROM mcp_agents' },
        { name: 'mcp_remote_calls', query: 'SELECT COUNT(*) FROM mcp_remote_calls' }
      ];
      
      console.log('🔍 Testing table existence:');
      for (const test of testQueries) {
        try {
          const { data, error } = await supabase.rpc('exec_sql', { sql: test.query });
          if (error) {
            console.log(`❌ ${test.name}: Does not exist (${error.message})`);
          } else {
            console.log(`✅ ${test.name}: Exists (${data?.[0]?.count || 0} rows)`);
          }
        } catch (err) {
          console.log(`❌ ${test.name}: Does not exist`);
        }
      }
    } else {
      console.log('✅ Current tables:');
      tables?.forEach(table => {
        console.log(`   - ${table.table_name}`);
      });
    }
    
    // Check if our migration has been applied
    console.log('');
    console.log('🔍 Checking for remote MCP tables...');
    
    const remoteTables = ['mcp_pkce_codes', 'mcp_agents', 'mcp_remote_calls'];
    const existingTables = [];
    const missingTables = [];
    
    for (const tableName of remoteTables) {
      try {
        const { data, error } = await supabase
          .from(tableName)
          .select('*')
          .limit(0);
          
        if (error) {
          missingTables.push(tableName);
        } else {
          existingTables.push(tableName);
        }
      } catch (err) {
        missingTables.push(tableName);
      }
    }
    
    if (existingTables.length > 0) {
      console.log('✅ Existing remote MCP tables:');
      existingTables.forEach(table => console.log(`   - ${table}`));
    }
    
    if (missingTables.length > 0) {
      console.log('❌ Missing remote MCP tables:');
      missingTables.forEach(table => console.log(`   - ${table}`));
    }
    
    console.log('');
    if (missingTables.length === 0) {
      console.log('🎉 All remote MCP tables exist! Schema is ready.');
    } else {
      console.log(`📋 Next steps: Create ${missingTables.length} missing tables in Supabase UI`);
      console.log('   1. Go to https://supabase.com/dashboard/project/olvbkozcufcbptfogatw/editor');
      console.log('   2. Create the missing tables listed above');
      console.log('   3. Run npm run migration:sync to generate migration files');
    }
    
  } catch (error) {
    console.error('❌ Error checking schema:', error.message);
  }
}

checkCurrentSchema();