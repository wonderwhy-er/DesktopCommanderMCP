import { AgentSelector } from './agent-selector.js';
import { ResultHandler } from './result-handler.js';
import { dispatchLogger } from '../../utils/logger.js';

const TOOL_CALL_TIMEOUT = 60000 * 5; // 5 minutes

/**
 * Tool Call Processor
 * Orchestrates tool execution by dispatching to remote agents
 */
export class ToolCallProcessor {
  constructor(supabase) {
    this.supabase = supabase;
    this.agentSelector = new AgentSelector(supabase);
    this.resultHandler = new ResultHandler();
    this.globalChannel = null;

    // Setup global result listener
    this.initializeGlobalListener();

    // Setup periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Initialize global listener for tool execution results
   */
  async initializeGlobalListener() {
    dispatchLogger.info('Initializing global listener for tool results');

    this.globalChannel = this.supabase.channel('mcp_global_results')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'mcp_remote_calls',
          filter: 'status=in.(completed,failed)'
        },
        (payload) => {
          this.handleToolCallUpdate(payload.new);
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          dispatchLogger.info('Global subscription active - listening for tool completions');
        } else {
          dispatchLogger.debug('Global subscription status changed', { status });
        }
      });
  }

  /**
   * Handle global update from Realtime
   */
  async handleToolCallUpdate(record) {
    const { id: call_id, result, error_message, status } = record;

    if (!this.resultHandler.isPending(call_id)) {
      // This is normal for restored sessions or duplicates, just ignore
      return;
    }

    dispatchLogger.debug('Received tool call update from Realtime', {
      callId: call_id,
      status
    });

    if (status === 'failed' || error_message) {
      this.resultHandler.handleError(call_id, error_message);
    } else {
      this.resultHandler.handleResult(call_id, result);
    }
  }

  /**
   * Dispatch tool call to remote agent
   * @param {string} userId - User ID
   * @param {string} toolName - Tool name to execute
   * @param {Object} args - Tool arguments
   * @param {string|null} agentId - Optional specific agent ID
   * @returns {Promise<Object>} Tool execution result
   */
  async dispatchTool(userId, toolName, args, agentId = null) {
    dispatchLogger.info('Starting tool dispatch', {
      userId,
      toolName,
      targetAgentId: agentId,
      hasArgs: !!args
    });

    // Determine target agent
    const targetAgentId = agentId || await this.agentSelector.getLastActiveAgentId(userId);

    if (!targetAgentId) {
      dispatchLogger.error('No agents available', { userId });
      throw new Error('No agents available - please connect an agent to use remote tools');
    }

    // Create remote call record
    const { data: remoteCall, error } = await this.supabase
      .from('mcp_remote_calls')
      .insert({
        user_id: userId,
        agent_id: targetAgentId,
        tool_name: toolName,
        tool_args: args,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      dispatchLogger.error('Failed to create remote call record', {
        userId,
        toolName,
        agentId: targetAgentId
      }, error);
      throw error;
    }

    dispatchLogger.info('Remote call record created - waiting for agent execution', {
      callId: remoteCall.id,
      userId,
      toolName,
      agentId: targetAgentId,
      timeoutSec: TOOL_CALL_TIMEOUT / 1000
    });

    // Return promise that resolves when result received
    return this.resultHandler.createPendingCall(remoteCall.id, userId, TOOL_CALL_TIMEOUT);
  }

  /**
   * Get all agents for user (delegates to AgentSelector)
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of agent records
   */
  async getUserAgents(userId) {
    return this.agentSelector.getUserAgents(userId);
  }

  /**
   * Mark call as failed in database
   * @param {string} callId - Call ID
   * @param {string} errorMessage - Error message
   */
  async markCallFailed(callId, errorMessage) {
    dispatchLogger.warn('Marking call as failed', { callId, errorMessage });

    await this.supabase
      .from('mcp_remote_calls')
      .update({
        status: 'failed',
        error_message: errorMessage,
        completed_at: new Date().toISOString()
      })
      .eq('id', callId);
  }

  /**
   * Periodic cleanup of timed out calls
   */
  startCleanupTimer() {
    const intervalSec = TOOL_CALL_TIMEOUT / 1000;
    dispatchLogger.info('Starting cleanup timer', { intervalSec });

    setInterval(async () => {
      try {
        // Cleanup database
        await this.supabase.rpc('cleanup_timed_out_calls');

        // Cleanup pending promises
        const cleanedCount = this.resultHandler.cleanupTimedOut(TOOL_CALL_TIMEOUT);

        if (cleanedCount > 0) {
          dispatchLogger.info('Cleanup cycle completed', {
            cleanedCount,
            pendingCount: this.resultHandler.getPendingCount()
          });
        }
      } catch (error) {
        dispatchLogger.error('Cleanup timer error', null, error);
      }
    }, TOOL_CALL_TIMEOUT);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    dispatchLogger.info('Cleaning up tool call processor');

    if (this.globalChannel) {
      await this.globalChannel.unsubscribe();
      dispatchLogger.info('Global channel unsubscribed');
    }
  }
}