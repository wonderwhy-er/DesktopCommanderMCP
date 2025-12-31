-- Supabase MCP Server Database Setup
-- Copy and paste this entire file into your Supabase SQL Editor

-- Enable RLS on auth.users (may already be enabled)
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;



-- Create MCP Tool Calls table
CREATE TABLE IF NOT EXISTS public.mcp_tool_calls (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    -- session_id reference removed as mcp_sessions table is deleted
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

ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;



-- RLS Policies for mcp_tool_calls
DROP POLICY IF EXISTS "Users can view their own tool calls" ON public.mcp_tool_calls;
CREATE POLICY "Users can view their own tool calls" ON public.mcp_tool_calls
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can insert tool calls" ON public.mcp_tool_calls;
CREATE POLICY "Service role can insert tool calls" ON public.mcp_tool_calls
    FOR INSERT WITH CHECK (current_setting('role') = 'service_role');

-- Create indexes for performance

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_user_id ON public.mcp_tool_calls(user_id);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_created_at ON public.mcp_tool_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_tool_name ON public.mcp_tool_calls(tool_name);