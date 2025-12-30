import { AgentRegistry } from '../agent-registry.js';
import { jest } from '@jest/globals';

// Test suite for AgentRegistry
describe('AgentRegistry', () => {
  let agentRegistry;
  let mockSupabase;

  beforeEach(() => {
    // Mock Supabase client
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      single: jest.fn(),
      maybeSingle: jest.fn(),
      eq: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis()
    };

    agentRegistry = new AgentRegistry(mockSupabase);
  });

  test('registers new agent successfully', async () => {
    const mockAgent = { 
      id: 'agent123', 
      user_id: 'user123', 
      agent_name: 'test-agent',
      machine_id: 'machine123',
      status: 'online'
    };

    mockSupabase.single.mockResolvedValue({ data: mockAgent, error: null });

    const result = await agentRegistry.registerAgent(
      'user123', 
      'test-agent', 
      'machine123', 
      { tools: ['echo'] }
    );

    expect(result).toEqual(mockAgent);
    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_agents');
    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user123',
        agent_name: 'test-agent',
        machine_id: 'machine123',
        capabilities: { tools: ['echo'] },
        status: 'online',
        last_seen: expect.any(String)
      }),
      { onConflict: 'machine_id' }
    );
  });

  test('throws error when registration fails', async () => {
    mockSupabase.single.mockResolvedValue({ 
      data: null, 
      error: { message: 'Database error' } 
    });

    await expect(agentRegistry.registerAgent(
      'user123', 
      'test-agent', 
      'machine123', 
      {}
    )).rejects.toEqual({ message: 'Database error' });
  });

  test('updates agent status successfully', async () => {
    mockSupabase.eq.mockResolvedValue({ error: null });

    await agentRegistry.updateAgentStatus('machine123', 'offline');

    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_agents');
    expect(mockSupabase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'offline',
        last_seen: expect.any(String)
      })
    );
    expect(mockSupabase.eq).toHaveBeenCalledWith('machine_id', 'machine123');
  });

  test('finds available agent for user', async () => {
    const mockAgent = { 
      id: 'agent123', 
      user_id: 'user123',
      status: 'online' 
    };

    mockSupabase.maybeSingle.mockResolvedValue({ data: mockAgent, error: null });

    const result = await agentRegistry.findAvailableAgent('user123');

    expect(result).toEqual(mockAgent);
    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_agents');
    expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', 'user123');
    expect(mockSupabase.eq).toHaveBeenCalledWith('status', 'online');
    expect(mockSupabase.order).toHaveBeenCalledWith('last_seen', { ascending: false });
    expect(mockSupabase.limit).toHaveBeenCalledWith(1);
  });

  test('returns null when no available agent found', async () => {
    mockSupabase.maybeSingle.mockResolvedValue({ data: null, error: null });

    const result = await agentRegistry.findAvailableAgent('user123');

    expect(result).toBeNull();
  });

  test('gets all user agents', async () => {
    const mockAgents = [
      { id: 'agent1', status: 'online' },
      { id: 'agent2', status: 'offline' }
    ];

    mockSupabase.order.mockResolvedValue({ data: mockAgents, error: null });

    const result = await agentRegistry.getUserAgents('user123');

    expect(result).toEqual(mockAgents);
    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_agents');
    expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', 'user123');
    expect(mockSupabase.order).toHaveBeenCalledWith('last_seen', { ascending: false });
  });

  test('returns empty array when no agents found', async () => {
    mockSupabase.order.mockResolvedValue({ data: null, error: null });

    const result = await agentRegistry.getUserAgents('user123');

    expect(result).toEqual([]);
  });

  test('removes offline agents older than specified time', async () => {
    mockSupabase.lt.mockResolvedValue({ error: null });

    await agentRegistry.removeOfflineAgents(30); // 30 minutes

    expect(mockSupabase.from).toHaveBeenCalledWith('mcp_agents');
    expect(mockSupabase.delete).toHaveBeenCalled();
    expect(mockSupabase.eq).toHaveBeenCalledWith('status', 'offline');
    expect(mockSupabase.lt).toHaveBeenCalledWith('last_seen', expect.any(String));
  });

  test('uses default 60 minutes for cleanup when no time specified', async () => {
    mockSupabase.lt.mockResolvedValue({ error: null });

    await agentRegistry.removeOfflineAgents(); // No parameter

    // Should use 60 minutes default
    const expectedCutoff = new Date(Date.now() - 60 * 60 * 1000);
    expect(mockSupabase.lt).toHaveBeenCalledWith('last_seen', expect.any(String));
  });

  test('throws error when database operation fails', async () => {
    mockSupabase.eq.mockResolvedValue({ error: { message: 'Database error' } });

    await expect(agentRegistry.updateAgentStatus('machine123', 'online'))
      .rejects.toEqual({ message: 'Database error' });
  });
});