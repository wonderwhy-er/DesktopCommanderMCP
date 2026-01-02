import { dispatchLogger } from '../../utils/logger.js';

/**
 * Agent Selection Module
 * Handles finding and selecting available agents for tool execution
 */

export class AgentSelector {
    constructor(supabase) {
        this.supabase = supabase;
    }

    /**
     * Find an online agent for a user, optionally targeting a specific agent
     * @param {string} userId - The user ID
     * @param {string|null} agentId - Optional specific agent ID to target
     * @returns {Promise<Object|null>} The agent record or null if not found
     */
    async findOnlineAgent(userId, agentId = null) {
        let query = this.supabase
            .from('mcp_agents')
            .select('*')
            .eq('user_id', userId)
            .eq('status', 'online');

        if (agentId) {
            // If specific agent requested, filter by id
            query = query.eq('id', agentId);
            dispatchLogger.debug('Finding specific agent', { userId, agentId });
        } else {
            // Otherwise get most recently seen
            query = query.order('last_seen', { ascending: false });
            dispatchLogger.debug('Finding most recent agent', { userId });
        }

        const { data: agent, error } = await query
            .limit(1)
            .maybeSingle();

        if (error) {
            dispatchLogger.error('Error finding agent', { userId, agentId }, error);
            throw error;
        }

        if (agent) {
            dispatchLogger.info('Agent found', {
                userId,
                agentId: agent.id,
                agentName: agent.agent_name,
                lastSeen: agent.last_seen
            });
        } else {
            dispatchLogger.warn('No online agent found', { userId, requestedAgentId: agentId });
        }

        return agent;
    }

    /**
     * Get the ID of the last active online agent for a user
     * @param {string} userId - The user ID
     * @returns {Promise<string|null>} The agent ID or null if not found
     */
    async getLastActiveAgentId(userId) {
        const { data, error } = await this.supabase
            .from('mcp_agents')
            .select('id')
            .eq('user_id', userId)
            .eq('status', 'online')
            .order('last_seen', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            dispatchLogger.error('Error finding last active agent', { userId }, error);
            return null;
        }

        const agentId = data?.id;
        if (agentId) {
            dispatchLogger.debug('Last active agent found', { userId, agentId });
        }

        return agentId;
    }

    /**
     * Get all agents for a user
     * @param {string} userId - The user ID
     * @returns {Promise<Array>} Array of agent records
     */
    async getUserAgents(userId) {
        const { data: agents, error } = await this.supabase
            .from('mcp_agents')
            .select('*')
            .eq('user_id', userId)
            .order('last_seen', { ascending: false });

        if (error) {
            dispatchLogger.error('Error getting user agents', { userId }, error);
            throw error;
        }

        dispatchLogger.debug('Retrieved user agents', {
            userId,
            count: agents?.length || 0
        });

        return agents || [];
    }
}
