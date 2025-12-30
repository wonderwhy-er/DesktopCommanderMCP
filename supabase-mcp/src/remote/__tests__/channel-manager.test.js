import { ChannelManager } from '../channel-manager.js';

// Basic functionality tests
describe('ChannelManager', () => {
  let channelManager;
  let mockSupabase;
  let mockChannel;

  beforeEach(() => {
    mockChannel = {
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn().mockResolvedValue(true),
      send: jest.fn().mockResolvedValue(true),
      unsubscribe: jest.fn().mockResolvedValue(true),
      presenceState: jest.fn().mockReturnValue({})
    };

    mockSupabase = {
      channel: jest.fn().mockReturnValue(mockChannel)
    };
    
    channelManager = new ChannelManager(mockSupabase);
  });

  test('subscribes to user channel', async () => {
    const userId = 'test-user-123';
    await channelManager.subscribeToUser(userId);
    
    expect(mockSupabase.channel).toHaveBeenCalledWith(`mcp_user_${userId}`);
    expect(channelManager.userChannels.has(userId)).toBe(true);
  });

  test('broadcasts tool call', async () => {
    const userId = 'test-user-123';
    await channelManager.subscribeToUser(userId);
    
    const toolCall = { tool_name: 'echo', args: { text: 'hello' } };
    await channelManager.broadcastToolCall(userId, toolCall);
    
    const channel = channelManager.userChannels.get(userId);
    expect(channel.send).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'tool_call',
      payload: toolCall
    });
  });

  test('broadcasts tool result', async () => {
    const userId = 'test-user-123';
    await channelManager.subscribeToUser(userId);
    
    const result = { success: true, data: 'response' };
    await channelManager.broadcastToolResult(userId, result);
    
    const channel = channelManager.userChannels.get(userId);
    expect(channel.send).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'tool_result',
      payload: result
    });
  });

  test('throws error when broadcasting to non-existent channel', async () => {
    const userId = 'nonexistent-user';
    const toolCall = { tool_name: 'echo', args: { text: 'hello' } };
    
    await expect(channelManager.broadcastToolCall(userId, toolCall))
      .rejects.toThrow(`No channel found for user ${userId}`);
  });

  test('unsubscribes from user channel', async () => {
    const userId = 'test-user-123';
    await channelManager.subscribeToUser(userId);
    
    expect(channelManager.userChannels.has(userId)).toBe(true);
    
    await channelManager.unsubscribeFromUser(userId);
    
    expect(mockChannel.unsubscribe).toHaveBeenCalled();
    expect(channelManager.userChannels.has(userId)).toBe(false);
  });

  test('gets active agents for user', async () => {
    const userId = 'test-user-123';
    const mockPresenceState = {
      'agent1': [{ agent_id: 'agent1', status: 'online' }],
      'agent2': [{ agent_id: 'agent2', status: 'online' }]
    };
    
    mockChannel.presenceState.mockReturnValue(mockPresenceState);
    await channelManager.subscribeToUser(userId);
    
    const activeAgents = channelManager.getActiveAgents(userId);
    expect(activeAgents).toHaveLength(2);
    expect(activeAgents[0]).toEqual({ agent_id: 'agent1', status: 'online' });
  });

  test('returns empty array for non-existent channel', () => {
    const activeAgents = channelManager.getActiveAgents('nonexistent-user');
    expect(activeAgents).toEqual([]);
  });

  test('registers event listeners', () => {
    const mockCallback = jest.fn();
    channelManager.on('tool_call', mockCallback);
    
    expect(channelManager.listeners.get('tool_call')).toBe(mockCallback);
  });

  test('handles tool call events', async () => {
    const mockCallback = jest.fn();
    const userId = 'test-user-123';
    const payload = { tool_name: 'echo', args: { text: 'test' } };
    
    channelManager.on('tool_call', mockCallback);
    channelManager.handleToolCall(userId, payload);
    
    expect(mockCallback).toHaveBeenCalledWith(userId, payload);
  });

  test('handles tool result events', async () => {
    const mockCallback = jest.fn();
    const userId = 'test-user-123';
    const payload = { success: true, data: 'result' };
    
    channelManager.on('tool_result', mockCallback);
    channelManager.handleToolResult(userId, payload);
    
    expect(mockCallback).toHaveBeenCalledWith(userId, payload);
  });

  test('cleanup unsubscribes all channels', async () => {
    const userId1 = 'test-user-1';
    const userId2 = 'test-user-2';
    
    await channelManager.subscribeToUser(userId1);
    await channelManager.subscribeToUser(userId2);
    
    expect(channelManager.userChannels.size).toBe(2);
    
    await channelManager.cleanup();
    
    expect(mockChannel.unsubscribe).toHaveBeenCalledTimes(2);
    expect(channelManager.userChannels.size).toBe(0);
    expect(channelManager.listeners.size).toBe(0);
  });
});