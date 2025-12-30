#!/usr/bin/env node

/**
 * Split migration into separate SQL files for manual execution
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function splitMigration() {
  console.log('📄 Splitting migration into executable chunks...');
  console.log('');

  // Read the migration file
  const migrationPath = join(__dirname, '../migrations/001_remote_mcp_schema.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf8');

  // Create output directory
  const outputDir = join(__dirname, '../migration-chunks');
  mkdirSync(outputDir, { recursive: true });

  // Define the chunks based on logical sections
  const chunks = [
    {
      name: '01_tables.sql',
      description: 'Create main tables',
      content: `-- Remote MCP Infrastructure Schema - Tables
-- Execute this first in Supabase SQL Editor

-- 1. PKCE Codes Table
CREATE TABLE IF NOT EXISTS mcp_pkce_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id TEXT UNIQUE NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT DEFAULT 'mcp:tools',
  resource TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '10 minutes')
);

-- 2. Agent Registration Table
CREATE TABLE IF NOT EXISTS mcp_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  machine_id TEXT UNIQUE NOT NULL,
  capabilities JSONB DEFAULT '{}',
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'connecting')),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  auth_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Remote Tool Calls Table
CREATE TABLE IF NOT EXISTS mcp_remote_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES mcp_agents(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_args JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 seconds')
);`
    },
    {
      name: '02_indexes.sql',
      description: 'Create indexes for performance',
      content: `-- Remote MCP Infrastructure Schema - Indexes
-- Execute this second

-- Indexes for PKCE codes
CREATE INDEX IF NOT EXISTS idx_pkce_codes_expires_at ON mcp_pkce_codes(expires_at);

-- Indexes for agents
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON mcp_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON mcp_agents(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_machine_id ON mcp_agents(machine_id);

-- Indexes for remote calls
CREATE INDEX IF NOT EXISTS idx_remote_calls_user_id ON mcp_remote_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_calls_agent_id ON mcp_remote_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_remote_calls_status ON mcp_remote_calls(status);
CREATE INDEX IF NOT EXISTS idx_remote_calls_timeout ON mcp_remote_calls(timeout_at);`
    },
    {
      name: '03_rls_policies.sql',
      description: 'Enable Row Level Security',
      content: `-- Remote MCP Infrastructure Schema - RLS Policies
-- Execute this third

-- Enable RLS on new tables
ALTER TABLE mcp_pkce_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_calls ENABLE ROW LEVEL SECURITY;

-- PKCE codes - publicly accessible (temporary auth data, no user context)
DROP POLICY IF EXISTS "PKCE codes are publicly accessible" ON mcp_pkce_codes;
CREATE POLICY "PKCE codes are publicly accessible" ON mcp_pkce_codes FOR ALL USING (true);

-- Agents - users can only see their own agents
DROP POLICY IF EXISTS "Users see own agents" ON mcp_agents;
CREATE POLICY "Users see own agents" ON mcp_agents FOR ALL USING (auth.uid() = user_id);

-- Remote calls - users can only see their own remote calls
DROP POLICY IF EXISTS "Users see own remote calls" ON mcp_remote_calls;
CREATE POLICY "Users see own remote calls" ON mcp_remote_calls FOR ALL USING (auth.uid() = user_id);`
    },
    {
      name: '04_functions.sql',
      description: 'Create cleanup functions',
      content: `-- Remote MCP Infrastructure Schema - Functions
-- Execute this fourth

-- Function to cleanup expired PKCE codes
CREATE OR REPLACE FUNCTION cleanup_expired_pkce_codes()
RETURNS void AS $$
BEGIN
  DELETE FROM mcp_pkce_codes WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to cleanup timed out remote calls
CREATE OR REPLACE FUNCTION cleanup_timed_out_calls()
RETURNS void AS $$
BEGIN
  UPDATE mcp_remote_calls 
  SET status = 'failed', 
      error_message = 'Timeout - no response from agent',
      completed_at = NOW()
  WHERE status IN ('pending', 'executing') 
    AND timeout_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to cleanup offline agents (optional, run periodically)
CREATE OR REPLACE FUNCTION cleanup_stale_agents()
RETURNS void AS $$
BEGIN
  -- Mark agents as offline if they haven't been seen in 5 minutes
  UPDATE mcp_agents 
  SET status = 'offline' 
  WHERE status = 'online' 
    AND last_seen < NOW() - INTERVAL '5 minutes';
    
  -- Delete offline agents that haven't been seen in 24 hours
  DELETE FROM mcp_agents 
  WHERE status = 'offline' 
    AND last_seen < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;`
    },
    {
      name: '05_realtime.sql',
      description: 'Enable real-time subscriptions',
      content: `-- Remote MCP Infrastructure Schema - Real-time
-- Execute this last

-- Enable real-time subscriptions for the tables
ALTER publication supabase_realtime ADD TABLE mcp_agents;
ALTER publication supabase_realtime ADD TABLE mcp_remote_calls;

-- Add table comments for documentation
COMMENT ON TABLE mcp_pkce_codes IS 'OAuth PKCE codes storage for secure authorization flow';
COMMENT ON TABLE mcp_agents IS 'Registry of remote MCP agents connected to the system';
COMMENT ON TABLE mcp_remote_calls IS 'Queue and tracking for remote tool call execution';`
    }
  ];

  // Write each chunk to a file
  chunks.forEach((chunk, index) => {
    const filePath = join(outputDir, chunk.name);
    writeFileSync(filePath, chunk.content);
    console.log(`✅ Created ${chunk.name} - ${chunk.description}`);
  });

  // Create execution instructions
  const instructions = `# 🎯 Remote MCP Database Migration Instructions

## Quick Setup

1. **Go to Supabase SQL Editor:**
   https://supabase.com/dashboard/project/olvbkozcufcbptfogatw/sql

2. **Execute the files in order:**

### Step 1: Create Tables
\`\`\`sql
-- Copy and paste the contents of 01_tables.sql
-- Click "Run" to execute
\`\`\`

### Step 2: Add Indexes  
\`\`\`sql
-- Copy and paste the contents of 02_indexes.sql
-- Click "Run" to execute
\`\`\`

### Step 3: Enable RLS
\`\`\`sql
-- Copy and paste the contents of 03_rls_policies.sql
-- Click "Run" to execute
\`\`\`

### Step 4: Create Functions
\`\`\`sql
-- Copy and paste the contents of 04_functions.sql
-- Click "Run" to execute
\`\`\`

### Step 5: Enable Real-time
\`\`\`sql
-- Copy and paste the contents of 05_realtime.sql
-- Click "Run" to execute
\`\`\`

## Verification

After executing all steps, run:
\`\`\`bash
node scripts/simple-table-check.js
\`\`\`

## Rollback (if needed)

To rollback, execute in reverse order:
\`\`\`sql
-- Drop tables
DROP TABLE IF EXISTS mcp_remote_calls;
DROP TABLE IF EXISTS mcp_agents;
DROP TABLE IF EXISTS mcp_pkce_codes;

-- Drop functions
DROP FUNCTION IF EXISTS cleanup_expired_pkce_codes();
DROP FUNCTION IF EXISTS cleanup_timed_out_calls();
DROP FUNCTION IF EXISTS cleanup_stale_agents();
\`\`\`

## Files Created

${chunks.map((chunk, i) => `${i + 1}. **${chunk.name}** - ${chunk.description}`).join('\n')}

**Ready to execute! Follow the steps above in the Supabase SQL Editor.**`;

  writeFileSync(join(outputDir, 'EXECUTE_MIGRATION.md'), instructions);
  console.log('✅ Created EXECUTE_MIGRATION.md - Follow these instructions');

  console.log('');
  console.log('🎯 Next Steps:');
  console.log('   1. Open: https://supabase.com/dashboard/project/olvbkozcufcbptfogatw/sql');
  console.log(`   2. Follow: ${outputDir}/EXECUTE_MIGRATION.md`);
  console.log('   3. Execute each SQL file in order');
  console.log('   4. Run: node scripts/simple-table-check.js');
  console.log('');
}

splitMigration();