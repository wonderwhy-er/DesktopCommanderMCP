-- Supabase MCP Server Database Setup
-- Copy and paste this entire file into your Supabase SQL Editor

-- Enable RLS on auth.users (may already be enabled)
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

-- Create MCP Sessions table
CREATE TABLE IF NOT EXISTS public.mcp_sessions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    session_token TEXT UNIQUE NOT NULL,
    client_info JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
    is_active BOOLEAN DEFAULT true
);

-- Create MCP Tool Calls table
CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
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
);

-- Enable RLS on new tables
ALTER TABLE public.mcp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;

-- RLS Policies for mcp_sessions
DROP POLICY IF EXISTS "Users can view their own sessions" ON public.mcp_sessions;
CREATE POLICY "Users can view their own sessions" ON public.mcp_sessions
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own sessions" ON public.mcp_sessions;
CREATE POLICY "Users can insert their own sessions" ON public.mcp_sessions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own sessions" ON public.mcp_sessions;
CREATE POLICY "Users can update their own sessions" ON public.mcp_sessions
    FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.mcp_sessions;
CREATE POLICY "Service role can manage all sessions" ON public.mcp_sessions
    FOR ALL USING (current_setting('role') = 'service_role');

-- RLS Policies for mcp_tool_calls
DROP POLICY IF EXISTS "Users can view their own tool calls" ON public.mcp_tool_calls;
CREATE POLICY "Users can view their own tool calls" ON public.mcp_tool_calls
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can insert tool calls" ON public.mcp_tool_calls;
CREATE POLICY "Service role can insert tool calls" ON public.mcp_tool_calls
    FOR INSERT WITH CHECK (current_setting('role') = 'service_role');

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user_id ON public.mcp_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_session_token ON public.mcp_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires_at ON public.mcp_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_user_id ON public.mcp_tool_calls(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_session_id ON public.mcp_tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created_at ON public.mcp_tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool_name ON public.mcp_tool_calls(tool_name);