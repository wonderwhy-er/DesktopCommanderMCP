import { ToolDispatcher } from '../tool-dispatcher.js';
import { jest } from '@jest/globals';

// Test suite for ToolDispatcher
describe('ToolDispatcher', () => {
  let toolDispatcher;
  let mockChannelManager;
  let mockAgentRegistry;
  let mockSupabase;

  beforeEach(() => {
    // Mock ChannelManager
    mockChannelManager = {
      on: jest.fn(),
      broadcastToolCall: jest.fn().mockResolvedValue(true)
    };

    // Mock AgentRegistry
    mockAgentRegistry = {
      findAvailableAgent: jest.fn(),
      getUserAgents: jest.fn()
    };

    // Mock Supabase client
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null })
    };

    // Create dispatcher
    toolDispatcher = new ToolDispatcher(mockChannelManager, mockAgentRegistry, mockSupabase);
    
    // Clear the interval to prevent issues
    jest.clearAllTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  test('throws error when no agent available', async () => {
    mockAgentRegistry.findAvailableAgent.mockResolvedValue(null);
    
    await expect(toolDispatcher.dispatchTool('user123', 'echo', { text: 'test' }))
      .rejects.toThrow('No agents available - please connect an agent to use remote tools');
  });

  test('successfully dispatches tool call', async () => {
    const mockAgent = { id: 'agent123', agent_name: 'test-agent' };
    const mockRemoteCall = { id: 'call123' };

    mockAgentRegistry.findAvailableAgent.mockResolvedValue(mockAgent);
    mockSupabase.insert.mockImplementation(() => ({
      select: () => ({
        single: jest.fn().mockResolvedValue({ data: mockRemoteCall, error: null })
      })
    }));
    mockSupabase.update.mockImplementation(() => ({
      eq: jest.fn().mockResolvedValue({ error: null })
    }));

    // Start the dispatch (don't await to test async behavior)
    const dispatchPromise = toolDispatcher.dispatchTool('user123', 'echo', { text: 'test' });

    // Verify database operations
    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_remote_calls');
    expect(mockChannelManager.broadcastToolCall).toHaveBeenCalledWith('user123', {
      call_id: 'call123',
      tool_name: 'echo',
      args: { text: 'test' }
    });

    // Simulate successful result
    toolDispatcher.handleToolResult('user123', {
      call_id: 'call123',
      result: { text: 'test echoed' }
    });

    const result = await dispatchPromise;
    expect(result).toEqual({ text: 'test echoed' });
  });

  test('handles tool call timeout', async () => {
    jest.useFakeTimers();
    
    const mockAgent = { id: 'agent123' };
    const mockRemoteCall = { id: 'call123' };

    mockAgentRegistry.findAvailableAgent.mockResolvedValue(mockAgent);
    mockSupabase.insert.mockImplementation(() => ({
      select: () => ({
        single: jest.fn().mockResolvedValue({ data: mockRemoteCall, error: null })
      })
    }));
    mockSupabase.update.mockImplementation(() => ({
      eq: jest.fn().mockResolvedValue({ error: null })
    }));

    const dispatchPromise = toolDispatcher.dispatchTool('user123', 'echo', { text: 'test' });

    // Fast forward time to trigger timeout
    jest.advanceTimersByTime(30000);

    await expect(dispatchPromise).rejects.toThrow('Tool call timeout - agent did not respond');
    
    jest.useRealTimers();
  });

  test('handles tool call error from agent', async () => {
    const mockAgent = { id: 'agent123' };
    const mockRemoteCall = { id: 'call123' };

    mockAgentRegistry.findAvailableAgent.mockResolvedValue(mockAgent);
    mockSupabase.insert.mockImplementation(() => ({
      select: () => ({
        single: jest.fn().mockResolvedValue({ data: mockRemoteCall, error: null })
      })
    }));
    mockSupabase.update.mockImplementation(() => ({
      eq: jest.fn().mockResolvedValue({ error: null })
    }));

    const dispatchPromise = toolDispatcher.dispatchTool('user123', 'echo', { text: 'test' });

    // Simulate error result
    toolDispatcher.handleToolResult('user123', {
      call_id: 'call123',
      error: 'Agent execution failed'
    });

    await expect(dispatchPromise).rejects.toThrow('Agent execution failed');
  });

  test('checks for connected agents', async () => {
    const mockAgents = [
      { status: 'online' },
      { status: 'offline' }
    ];

    mockAgentRegistry.getUserAgents.mockResolvedValue(mockAgents);

    const hasConnected = await toolDispatcher.hasConnectedAgents('user123');
    expect(hasConnected).toBe(true);
  });

  test('returns empty tools when no agents connected', async () => {
    mockAgentRegistry.getUserAgents.mockResolvedValue([]);

    const tools = await toolDispatcher.getAvailableTools('user123');
    expect(tools).toEqual([]);
  });

  test('returns stub echo tool when agents connected', async () => {
    const mockAgents = [{ status: 'online' }];
    mockAgentRegistry.getUserAgents.mockResolvedValue(mockAgents);

    const tools = await toolDispatcher.getAvailableTools('user123');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('remote_echo');
  });

  test('ignores unknown tool results', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    
    toolDispatcher.handleToolResult('user123', {
      call_id: 'unknown123',
      result: { text: 'test' }
    });

    expect(consoleSpy).toHaveBeenCalledWith('Received result for unknown call: unknown123');
    consoleSpy.mockRestore();
  });

  test('marks call as completed in database', async () => {
    mockSupabase.update.mockImplementation(() => ({
      eq: jest.fn().mockResolvedValue({ error: null })
    }));

    await toolDispatcher.markCallCompleted('call123', { text: 'result' });

    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_remote_calls');
    expect(mockSupabase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        result: { text: 'result' },
        completed_at: expect.any(String)
      })
    );
  });

  test('marks call as failed in database', async () => {
    mockSupabase.update.mockImplementation(() => ({
      eq: jest.fn().mockResolvedValue({ error: null })
    }));

    await toolDispatcher.markCallFailed('call123', 'Test error');

    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_remote_calls');
    expect(mockSupabase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error_message: 'Test error',
        completed_at: expect.any(String)
      })
    );
  });
});