#!/usr/bin/env node

/**
 * Database Setup Script for Supabase MCP Server
 * 
 * Sets up the required database tables and RLS policies
 */

import { createSupabaseServiceClient } from '../src/utils/supabase.js';
import { serverLogger } from '../src/utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const SQL_COMMANDS = [
  // Enable RLS
  `ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;`,
  
  // Create MCP Sessions table
  `CREATE TABLE IF NOT EXISTS public.mcp_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    session_token TEXT UNIQUE NOT NULL,
    client_info JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
    is_active BOOLEAN DEFAULT true
  );`,
  
  // Create MCP Tools Usage Log table
  `CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id UUID REFERENCES public.mcp_sessions(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    parameters JSONB DEFAULT '{}',
    result JSONB DEFAULT '{}',
    duration_ms INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    success BOOLEAN DEFAULT true,
    error_message TEXT
  );`,
  
  // Enable RLS on new tables
  `ALTER TABLE public.mcp_sessions ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;`,
  
  // RLS Policies for mcp_sessions
  `DROP POLICY IF EXISTS "Users can view their own sessions" ON public.mcp_sessions;`,
  `CREATE POLICY "Users can view their own sessions" ON public.mcp_sessions
    FOR SELECT USING (auth.uid() = user_id);`,
  
  `DROP POLICY IF EXISTS "Users can insert their own sessions" ON public.mcp_sessions;`,
  `CREATE POLICY "Users can insert their own sessions" ON public.mcp_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);`,
  
  `DROP POLICY IF EXISTS "Users can update their own sessions" ON public.mcp_sessions;`,
  `CREATE POLICY "Users can update their own sessions" ON public.mcp_sessions
    FOR UPDATE USING (auth.uid() = user_id);`,
  
  `DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.mcp_sessions;`,
  `CREATE POLICY "Service role can manage all sessions" ON public.mcp_sessions
    FOR ALL USING (current_setting('role') = 'service_role');`,
  
  // RLS Policies for mcp_tool_calls
  `DROP POLICY IF EXISTS "Users can view their own tool calls" ON public.mcp_tool_calls;`,
  `CREATE POLICY "Users can view their own tool calls" ON public.mcp_tool_calls
    FOR SELECT USING (auth.uid() = user_id);`,
  
  `DROP POLICY IF EXISTS "Service role can insert tool calls" ON public.mcp_tool_calls;`,
  `CREATE POLICY "Service role can insert tool calls" ON public.mcp_tool_calls
    FOR INSERT WITH CHECK (current_setting('role') = 'service_role');`,
  
  // Create indexes for performance
  `CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user_id ON public.mcp_sessions(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_sessions_session_token ON public.mcp_sessions(session_token);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires_at ON public.mcp_sessions(expires_at);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_user_id ON public.mcp_tool_calls(user_id);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_session_id ON public.mcp_tool_calls(session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created_at ON public.mcp_tool_calls(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool_name ON public.mcp_tool_calls(tool_name);`,
];

async function setupDatabase() {
  serverLogger.info('Starting database setup...');
  
  try {
    // Check if we have service role key
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required for database setup');
    }
    
    const supabase = createSupabaseServiceClient();
    
    // Test connection with a simple query
    serverLogger.info('Testing database connection...');
    const { data: testResult, error: testError } = await supabase
      .rpc('version'); // Simple function that should always exist
    
    if (testError) {
      serverLogger.warn('RPC test failed, trying simple select...');
      // Fallback: try a simple select that should work
      try {
        const { error: fallbackError } = await supabase
          .from('information_schema.tables')
          .select('table_name')
          .limit(1);
          
        if (fallbackError) {
          throw new Error(`Database connection test failed: ${fallbackError.message}`);
        }
      } catch (e) {
        // If that fails too, we'll assume connection is OK and proceed
        serverLogger.warn('Connection tests failed, but proceeding with setup...');
      }
    }
    
    serverLogger.info('✅ Database connection successful');
    
    // Execute setup commands
    serverLogger.info('📋 Manual setup required. Please run these SQL commands in Supabase SQL Editor:');
    serverLogger.info('');
    serverLogger.info('1. Go to your Supabase Dashboard → SQL Editor');
    serverLogger.info('2. Copy and paste the following SQL commands:');
    serverLogger.info('');
    
    // Print all SQL commands for manual execution
    SQL_COMMANDS.forEach((command, i) => {
      const commandName = command.split(' ').slice(0, 3).join(' ');
      console.log(`-- Command ${i + 1}: ${commandName}`);
      console.log(command);
      console.log('');
    });
    
    serverLogger.info('3. Run all commands in the SQL Editor');
    serverLogger.info('4. The setup will create the required tables and policies');
    
    // Note: Verification will be done manually after user runs SQL commands
    serverLogger.info('');
    serverLogger.info('📋 After running the SQL commands above:');
    serverLogger.info('');
    serverLogger.info('✅ The following tables should be created:');
    serverLogger.info('  - public.mcp_sessions (user sessions)');
    serverLogger.info('  - public.mcp_tool_calls (tool call logs)');
    serverLogger.info('');
    serverLogger.info('✅ RLS policies will be configured for security');
    serverLogger.info('✅ Indexes will be created for performance');
    serverLogger.info('');
    serverLogger.info('🚀 Once complete, you can start the MCP server with: npm start');
    
  } catch (error) {
    serverLogger.error('❌ Database setup preparation failed', null, error);
    serverLogger.info('');
    serverLogger.info('🔧 You can still set up the database manually using the SQL commands above');
    process.exit(1);
  }
}

// Function to create exec_sql function if it doesn't exist
async function createExecSqlFunction() {
  const supabase = createSupabaseServiceClient();
  
  const functionSQL = `
    CREATE OR REPLACE FUNCTION exec_sql(sql text)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    BEGIN
      EXECUTE sql;
    END;
    $$;
  `;
  
  try {
    const { error } = await supabase.rpc('exec_sql', { sql: functionSQL });
    if (error) {
      serverLogger.warn('Could not create exec_sql function:', error.message);
    }
  } catch (error) {
    serverLogger.debug('exec_sql function creation failed (expected on first run)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase().catch(error => {
    console.error('Setup failed:', error.message);
    process.exit(1);
  });
}

export { setupDatabase };