#!/usr/bin/env node

import { createSupabaseClient } from '../src/utils/supabase.js';

async function checkTables() {
  const supabase = createSupabaseClient();
  
  const tables = ['mcp_sessions', 'mcp_pkce_codes', 'mcp_agents', 'mcp_remote_calls'];
  
  console.log('🔍 Checking table existence:');
  for (const tableName of tables) {
    try {
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .limit(1);
        
      if (error) {
        console.log(`❌ ${tableName}: ${error.message}`);
      } else {
        console.log(`✅ ${tableName}: Exists`);
      }
    } catch (err) {
      console.log(`❌ ${tableName}: ${err.message}`);
    }
  }
}

checkTables();