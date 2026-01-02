-- Remote MCP Infrastructure Schema
-- This migration adds tables for remote agent management and PKCE storage



-- 2. Agent Registration Table
CREATE TABLE IF NOT EXISTS mcp_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  capabilities JSONB DEFAULT '{}',
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'connecting')),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  auth_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_agents_user_id ON mcp_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON mcp_agents(status);
-- Unique index removed as we no longer use device_id. ID is primary key.

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
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_remote_calls_user_id ON mcp_remote_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_remote_calls_agent_id ON mcp_remote_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_remote_calls_status ON mcp_remote_calls(status);
CREATE INDEX IF NOT EXISTS idx_remote_calls_timeout ON mcp_remote_calls(timeout_at);

-- 4. Row Level Security Policies
-- Enable RLS on new tables

ALTER TABLE mcp_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_calls ENABLE ROW LEVEL SECURITY;



-- Agents - users can only see their own agents
DROP POLICY IF EXISTS "Users see own agents" ON mcp_agents;
CREATE POLICY "Users see own agents" ON mcp_agents FOR ALL USING (auth.uid() = user_id);

-- Remote calls - users can only see their own remote calls
DROP POLICY IF EXISTS "Users see own remote calls" ON mcp_remote_calls;
CREATE POLICY "Users see own remote calls" ON mcp_remote_calls FOR ALL USING (auth.uid() = user_id);

-- 5. Cleanup Functions


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
$$ LANGUAGE plpgsql;

-- 6. Enable real-time subscriptions for the tables (if needed)
-- This ensures Supabase real-time works on these tables
ALTER publication supabase_realtime ADD TABLE mcp_agents;
ALTER publication supabase_realtime ADD TABLE mcp_remote_calls;


COMMENT ON TABLE mcp_agents IS 'Registry of remote MCP agents connected to the system';
COMMENT ON TABLE mcp_remote_calls IS 'Queue and tracking for remote tool call execution';