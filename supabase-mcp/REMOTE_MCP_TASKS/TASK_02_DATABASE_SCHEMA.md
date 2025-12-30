# Task 02: Database Schema for Remote MCP

## Objective
Create the necessary database tables and policies for remote agent management and tool call coordination.

## Scope
- Add tables for agent registration and management
- Add tables for remote tool call queue
- Add tables for PKCE code persistence
- Implement Row Level Security policies
- Create necessary indexes for performance

## Database Schema

### 1. PKCE Codes Table
```sql
CREATE TABLE mcp_pkce_codes (
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

-- Auto cleanup expired codes
CREATE INDEX idx_pkce_codes_expires_at ON mcp_pkce_codes(expires_at);
```

### 2. Agent Registration Table
```sql
CREATE TABLE mcp_agents (
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

-- Indexes for performance
CREATE INDEX idx_agents_user_id ON mcp_agents(user_id);
CREATE INDEX idx_agents_status ON mcp_agents(status);
CREATE UNIQUE INDEX idx_agents_machine_id ON mcp_agents(machine_id);
```

### 3. Remote Tool Calls Table
```sql
CREATE TABLE mcp_remote_calls (
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
CREATE INDEX idx_remote_calls_user_id ON mcp_remote_calls(user_id);
CREATE INDEX idx_remote_calls_agent_id ON mcp_remote_calls(agent_id);
CREATE INDEX idx_remote_calls_status ON mcp_remote_calls(status);
CREATE INDEX idx_remote_calls_timeout ON mcp_remote_calls(timeout_at);
```

### 4. Row Level Security Policies
```sql
-- Enable RLS
ALTER TABLE mcp_pkce_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_calls ENABLE ROW LEVEL SECURITY;

-- PKCE codes - no user context needed (temporary auth data)
CREATE POLICY "PKCE codes are publicly accessible" ON mcp_pkce_codes FOR ALL USING (true);

-- Agents - users can only see their own
CREATE POLICY "Users see own agents" ON mcp_agents FOR ALL USING (auth.uid() = user_id);

-- Remote calls - users can only see their own
CREATE POLICY "Users see own remote calls" ON mcp_remote_calls FOR ALL USING (auth.uid() = user_id);
```

### 5. Cleanup Functions
```sql
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
```

## Migration Script
Create `migrations/001_remote_mcp_schema.sql` with all above SQL.

## Acceptance Criteria
- [ ] All tables created successfully
- [ ] RLS policies working correctly
- [ ] Indexes created for performance
- [ ] Cleanup functions working
- [ ] Migration script runs without errors
- [ ] Existing data unaffected

## Dependencies
- Task 01 (Preparation) - for PKCE table usage

## Estimated Time
2-3 hours