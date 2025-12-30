# Task 03: Supabase Real-time Channel Manager

## Objective
Implement real-time communication infrastructure using Supabase channels for coordinating tool calls between base server and remote agents.

## Scope
- Create ChannelManager class for Supabase real-time subscriptions
- Implement user-specific channels for tool call coordination
- Handle presence tracking for agent connectivity
- Manage broadcast events for tool calls and results

## Implementation

### 1. Channel Manager Class
Create `src/remote/channel-manager.js`:

```javascript
export class ChannelManager {
  constructor(supabase) {
    this.supabase = supabase;
    this.userChannels = new Map(); // userId -> channel
    this.listeners = new Map(); // event -> callback
  }

  // Subscribe to user-specific channel
  async subscribeToUser(userId) {
    const channelName = `mcp_user_${userId}`;
    
    const channel = this.supabase.channel(channelName)
      .on('broadcast', { event: 'tool_call' }, (payload) => {
        this.handleToolCall(userId, payload);
      })
      .on('broadcast', { event: 'tool_result' }, (payload) => {
        this.handleToolResult(userId, payload);
      })
      .on('presence', { event: 'sync' }, () => {
        this.handlePresenceSync(userId, channelName);
      })
      .on('presence', { event: 'join' }, (payload) => {
        this.handlePresenceJoin(userId, payload);
      })
      .on('presence', { event: 'leave' }, (payload) => {
        this.handlePresenceLeave(userId, payload);
      })
      .subscribe();

    this.userChannels.set(userId, channel);
    return channel;
  }

  // Broadcast tool call to agents
  async broadcastToolCall(userId, toolCall) {
    const channel = this.userChannels.get(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    return channel.send({
      type: 'broadcast',
      event: 'tool_call',
      payload: toolCall
    });
  }

  // Broadcast tool result back to server
  async broadcastToolResult(userId, result) {
    const channel = this.userChannels.get(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    return channel.send({
      type: 'broadcast',
      event: 'tool_result',
      payload: result
    });
  }

  // Event handlers
  handleToolCall(userId, payload) {
    const callback = this.listeners.get('tool_call');
    if (callback) {
      callback(userId, payload);
    }
  }

  handleToolResult(userId, payload) {
    const callback = this.listeners.get('tool_result');
    if (callback) {
      callback(userId, payload);
    }
  }

  handlePresenceSync(userId, channelName) {
    const channel = this.userChannels.get(userId);
    if (channel) {
      const presenceState = channel.presenceState();
      console.log(`Presence sync for user ${userId}:`, presenceState);
    }
  }

  handlePresenceJoin(userId, payload) {
    console.log(`Agent joined for user ${userId}:`, payload);
  }

  handlePresenceLeave(userId, payload) {
    console.log(`Agent left for user ${userId}:`, payload);
  }

  // Register event listeners
  on(event, callback) {
    this.listeners.set(event, callback);
  }

  // Unsubscribe from user channel
  async unsubscribeFromUser(userId) {
    const channel = this.userChannels.get(userId);
    if (channel) {
      await channel.unsubscribe();
      this.userChannels.delete(userId);
    }
  }

  // Get active agents for user
  getActiveAgents(userId) {
    const channel = this.userChannels.get(userId);
    if (!channel) return [];

    const presenceState = channel.presenceState();
    return Object.values(presenceState).flat();
  }

  // Cleanup all channels
  async cleanup() {
    for (const [userId, channel] of this.userChannels) {
      await channel.unsubscribe();
    }
    this.userChannels.clear();
    this.listeners.clear();
  }
}
```

### 2. Integration with Main Server
Update `src/server/mcp-server.js`:

```javascript
import { ChannelManager } from '../remote/channel-manager.js';

class SupabaseMCPServer {
  constructor() {
    // ... existing setup ...
    
    // Initialize channel manager
    this.channelManager = new ChannelManager(this.supabase);
    
    // Setup channel event listeners
    this.setupChannelListeners();
  }

  setupChannelListeners() {
    // Handle tool results from agents
    this.channelManager.on('tool_result', (userId, payload) => {
      // Will be implemented in Task 04 (Tool Dispatcher)
      console.log(`Tool result from user ${userId}:`, payload);
    });
  }

  // Subscribe user to their channel on first MCP connection
  async ensureUserChannel(userId) {
    if (!this.channelManager.userChannels.has(userId)) {
      await this.channelManager.subscribeToUser(userId);
    }
  }
}
```

### 3. Testing Utilities
Create `src/remote/__tests__/channel-manager.test.js`:

```javascript
import { ChannelManager } from '../channel-manager.js';

// Basic functionality tests
describe('ChannelManager', () => {
  let channelManager;
  let mockSupabase;

  beforeEach(() => {
    mockSupabase = {
      channel: jest.fn().mockReturnValue({
        on: jest.fn().mockReturnThis(),
        subscribe: jest.fn().mockResolvedValue(true),
        send: jest.fn().mockResolvedValue(true),
        unsubscribe: jest.fn().mockResolvedValue(true),
        presenceState: jest.fn().mockReturnValue({})
      })
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
});
```

## Acceptance Criteria
- [ ] ChannelManager class implemented
- [ ] User-specific channel subscriptions working
- [ ] Broadcast functionality for tool calls and results
- [ ] Presence tracking for agent connectivity
- [ ] Event listener system for handling messages
- [ ] Integration with main server
- [ ] Basic tests passing
- [ ] No impact on existing functionality

## Dependencies
- Task 01 (Preparation) - for clean codebase
- Task 02 (Database Schema) - for agent tracking

## Estimated Time
3-4 hours