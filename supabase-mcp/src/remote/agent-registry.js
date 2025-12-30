export class AgentRegistry {
  constructor(supabase) {
    this.supabase = supabase;
  }

  // Register or update agent
  async registerAgent(userId, agentName, machineId, capabilities) {
    const { data: agent, error } = await this.supabase
      .from('mcp_agents')
      .upsert({
        user_id: userId,
        agent_name: agentName,
        machine_id: machineId,
        capabilities: capabilities,
        status: 'online',
        last_seen: new Date().toISOString()
      }, {
        onConflict: 'machine_id'
      })
      .select()
      .single();

    if (error) throw error;
    return agent;
  }

  // Update agent status and last seen
  async updateAgentStatus(machineId, status) {
    const { error } = await this.supabase
      .from('mcp_agents')
      .update({
        status: status,
        last_seen: new Date().toISOString()
      })
      .eq('machine_id', machineId);

    if (error) throw error;
  }

  // Find available agent for user (currently single agent per user)
  async findAvailableAgent(userId) {
    console.log(`🔍 [AGENT_REGISTRY] Finding available agent for user: ${userId}`);

    // First, list ALL agents to see what's in the database
    const { data: allAgents, error: allError } = await this.supabase
      .from('mcp_agents')
      .select('*');

    console.log(`📊 [AGENT_REGISTRY] Total agents in database: ${allAgents?.length || 0}`);
    if (allAgents && allAgents.length > 0) {
      allAgents.forEach((a, idx) => {
        console.log(`  Agent #${idx + 1}: user_id=${a.user_id}, status=${a.status}, name=${a.agent_name}`);
      });
    }

    // Now search for this specific user's online agent
    const { data: agent, error } = await this.supabase
      .from('mcp_agents')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'online')
      .order('last_seen', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`❌ [AGENT_REGISTRY] Error finding agent:`, error);
      throw error;
    }

    console.log(`🎯 [AGENT_REGISTRY] Search result for user ${userId}:`, {
      found: !!agent,
      agentId: agent?.id,
      agentName: agent?.agent_name,
      status: agent?.status
    });

    return agent;
  }

  // Get all agents for user
  async getUserAgents(userId) {
    const { data: agents, error } = await this.supabase
      .from('mcp_agents')
      .select('*')
      .eq('user_id', userId)
      .order('last_seen', { ascending: false });

    if (error) throw error;
    return agents || [];
  }

  // Remove offline agents (cleanup)
  async removeOfflineAgents(olderThanMinutes = 60) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

    const { error } = await this.supabase
      .from('mcp_agents')
      .delete()
      .eq('status', 'offline')
      .lt('last_seen', cutoff);

    if (error) throw error;
  }
}