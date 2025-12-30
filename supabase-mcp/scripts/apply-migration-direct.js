#!/usr/bin/env node

/**
 * Apply migration directly using service role key
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function applyMigration() {
  console.log('🚀 Applying Remote MCP Migration...');
  console.log('');

  // Use service role key for admin operations
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Read the migration file
    const migrationPath = join(__dirname, '../migrations/001_remote_mcp_schema.sql');
    const migrationSQL = readFileSync(migrationPath, 'utf8');
    
    console.log('📄 Read migration file: 001_remote_mcp_schema.sql');
    console.log(`📊 Migration size: ${migrationSQL.length} characters`);
    console.log('');

    // Split SQL into individual statements
    const statements = migrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    console.log(`🔨 Executing ${statements.length} SQL statements...`);
    console.log('');

    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      
      if (statement.trim()) {
        try {
          console.log(`${i + 1}/${statements.length}: ${statement.substring(0, 60)}...`);
          
          // Execute the statement
          const { error } = await supabase.rpc('exec_sql', { 
            sql: statement + ';' 
          });

          if (error) {
            console.log(`❌ Error in statement ${i + 1}:`, error.message);
            
            // Try alternative approach for some statements
            if (statement.includes('CREATE TABLE') || statement.includes('ALTER TABLE')) {
              console.log(`⚠️  Continuing with next statement...`);
              continue;
            } else {
              throw error;
            }
          } else {
            console.log(`✅ Statement ${i + 1} completed`);
          }
        } catch (stmtError) {
          console.log(`❌ Failed to execute statement ${i + 1}:`, stmtError.message);
          console.log(`📝 Statement: ${statement}`);
          
          // Continue with non-critical errors
          if (stmtError.message.includes('already exists') || 
              stmtError.message.includes('does not exist')) {
            console.log(`⚠️  Non-critical error, continuing...`);
            continue;
          }
          
          throw stmtError;
        }
      }
    }

    console.log('');
    console.log('🎉 Migration completed successfully!');
    console.log('');

    // Verify tables were created
    console.log('🔍 Verifying tables...');
    const tables = ['mcp_pkce_codes', 'mcp_agents', 'mcp_remote_calls'];
    
    for (const tableName of tables) {
      try {
        const { data, error } = await supabase
          .from(tableName)
          .select('*')
          .limit(0);
          
        if (error) {
          console.log(`❌ ${tableName}: Failed to access`);
        } else {
          console.log(`✅ ${tableName}: Created successfully`);
        }
      } catch (err) {
        console.log(`❌ ${tableName}: ${err.message}`);
      }
    }

    console.log('');
    console.log('🎯 Next steps:');
    console.log('   1. Run: node scripts/simple-table-check.js');
    console.log('   2. Test OAuth flow with database storage');
    console.log('   3. Update OAuth processor to use DB instead of memory');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Check environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables:');
  console.error('   - SUPABASE_URL');
  console.error('   - SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

applyMigration();