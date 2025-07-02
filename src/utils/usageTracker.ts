import { configManager } from '../config-manager.js';

export interface ToolUsageStats {
  // Tool category counters
  filesystemOperations: number;
  terminalOperations: number;
  editOperations: number;
  searchOperations: number;
  configOperations: number;
  processOperations: number;

  // Overall counters
  totalToolCalls: number;
  successfulCalls: number;
  failedCalls: number;

  // Tool-specific counters
  toolCounts: Record<string, number>;

  // Timing information
  firstUsed: number; // timestamp
  lastUsed: number; // timestamp
  totalSessions: number; // rough session counter

  // User interaction tracking
  feedbackGiven: boolean;
  lastFeedbackPrompt: number; // timestamp
}

export interface UsageSession {
  sessionStart: number;
  lastActivity: number;
  commandsInSession: number;
}

// Tool categories mapping
const TOOL_CATEGORIES = {
  filesystem: ['read_file', 'read_multiple_files', 'write_file', 'create_directory', 'list_directory', 'move_file', 'get_file_info'],
  terminal: ['execute_command', 'read_output', 'force_terminate', 'list_sessions'],
  edit: ['edit_block'],
  search: ['search_files', 'search_code'],
  config: ['get_config', 'set_config_value'],
  process: ['list_processes', 'kill_process']
};

// Session timeout (30 minutes of inactivity = new session)
const SESSION_TIMEOUT = 30 * 60 * 1000;

class UsageTracker {
  private currentSession: UsageSession | null = null;

  /**
   * Get default usage stats
   */
  private getDefaultStats(): ToolUsageStats {
    return {
      filesystemOperations: 0,
      terminalOperations: 0,
      editOperations: 0,
      searchOperations: 0,
      configOperations: 0,
      processOperations: 0,
      totalToolCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      toolCounts: {},
      firstUsed: Date.now(),
      lastUsed: Date.now(),
      totalSessions: 1,
      feedbackGiven: false,
      lastFeedbackPrompt: 0
    };
  }

  /**
   * Get current usage stats from config
   */
  async getStats(): Promise<ToolUsageStats> {
    const stats = await configManager.getValue('usageStats');
    return stats || this.getDefaultStats();
  }

  /**
   * Save usage stats to config
   */
  private async saveStats(stats: ToolUsageStats): Promise<void> {
    await configManager.setValue('usageStats', stats);
  }

  /**
   * Determine which category a tool belongs to
   */
  private getToolCategory(toolName: string): keyof Omit<ToolUsageStats, 'totalToolCalls' | 'successfulCalls' | 'failedCalls' | 'toolCounts' | 'firstUsed' | 'lastUsed' | 'totalSessions' | 'feedbackGiven' | 'lastFeedbackPrompt'> | null {
    for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
      if (tools.includes(toolName)) {
        switch (category) {
          case 'filesystem': return 'filesystemOperations';
          case 'terminal': return 'terminalOperations';
          case 'edit': return 'editOperations';
          case 'search': return 'searchOperations';
          case 'config': return 'configOperations';
          case 'process': return 'processOperations';
        }
      }
    }
    return null;
  }

  /**
   * Check if we're in a new session
   */
  private isNewSession(): boolean {
    if (!this.currentSession) return true;

    const now = Date.now();
    const timeSinceLastActivity = now - this.currentSession.lastActivity;

    return timeSinceLastActivity > SESSION_TIMEOUT;
  }

  /**
   * Update session tracking
   */
  private updateSession(): void {
    const now = Date.now();

    if (this.isNewSession()) {
      this.currentSession = {
        sessionStart: now,
        lastActivity: now,
        commandsInSession: 1
      };
    } else {
      this.currentSession!.lastActivity = now;
      this.currentSession!.commandsInSession++;
    }
  }

  /**
   * Track a successful tool call
   */
  async trackSuccess(toolName: string): Promise<ToolUsageStats> {
    const stats = await this.getStats();

    // Update session
    this.updateSession();

    // Update counters
    stats.totalToolCalls++;
    stats.successfulCalls++;
    stats.lastUsed = Date.now();

    // Update tool-specific counter
    stats.toolCounts[toolName] = (stats.toolCounts[toolName] || 0) + 1;

    // Update category counter
    const category = this.getToolCategory(toolName);
    if (category) {
      stats[category]++;
    }

    // Update session count if this is a new session
    if (this.currentSession?.commandsInSession === 1) {
      stats.totalSessions++;
    }

    await this.saveStats(stats);
    return stats;
  }

  /**
   * Track a failed tool call
   */
  async trackFailure(toolName: string): Promise<ToolUsageStats> {
    const stats = await this.getStats();

    // Update session
    this.updateSession();

    // Update counters
    stats.totalToolCalls++;
    stats.failedCalls++;
    stats.lastUsed = Date.now();

    // Update tool-specific counter (we count failures too)
    stats.toolCounts[toolName] = (stats.toolCounts[toolName] || 0) + 1;

    // Update category counter
    const category = this.getToolCategory(toolName);
    if (category) {
      stats[category]++;
    }

    // Update session count if this is a new session
    if (this.currentSession?.commandsInSession === 1) {
      stats.totalSessions++;
    }

    await this.saveStats(stats);
    return stats;
  }

  /**
   * Check if user should be prompted for feedback based on usage patterns
   */
  async shouldPromptForFeedback(): Promise<boolean> {
    const stats = await this.getStats();

    // Don't prompt if feedback already given
    if (stats.feedbackGiven) return false;

    // Check if enough time has passed since last prompt (2 hours)
    const now = Date.now();
    const hoursSinceLastPrompt = (now - stats.lastFeedbackPrompt) / (1000 * 60 * 60);
    if (stats.lastFeedbackPrompt > 0 && hoursSinceLastPrompt < 2) return false;

    // MAIN TRIGGER: 3000+ total tool calls
    return stats.totalToolCalls >= 3000;
  }

  /**
   * Get a random feedback prompt message (P.S. style, non-intrusive)
   */
  async getFeedbackPromptMessage(): Promise<string> {
    const messages = [
      "**P.S.** Looks like you're getting good use out of Desktop Commander! If you have a moment, we'd appreciate your feedback to help guide where the product goes next. We'll share your usage stats (tool usage, success rate, platform) to help us understand patterns. You can also opt-in to participate in user studies. [Give feedback](command:give_feedback_to_desktop_commander)",

      "**P.S.** Seems like Desktop Commander is working well for you! Your feedback would help us decide on future features and improvements. We'll include your usage data (commands run, tools used, OS) to better understand user needs. Option to join user research calls available too. [Share your thoughts](command:give_feedback_to_desktop_commander)",

      "**P.S.** You're clearly making good use of Desktop Commander! Consider helping the team by sharing feedback about your experience. We'll send your usage patterns along to help prioritize development. You can also volunteer for user interviews if interested. [Give feedback](command:give_feedback_to_desktop_commander)",

      "**P.S.** Desktop Commander seems to be serving you well! Your input would help shape the product roadmap. We'll include usage metrics (tool counts, platform, success rate) to understand user workflows better. Option to participate in user studies is also available. [Provide feedback](command:give_feedback_to_desktop_commander)",

      "**P.S.** Looks like you've found Desktop Commander useful! A quick feedback would help us understand what's working and what could improve. We'll share your usage data to help inform development decisions. You can also opt-in for user research participation. [Share feedback](command:give_feedback_to_desktop_commander)",

      "**P.S.** You seem to be getting value from Desktop Commander! Your feedback would help guide future development priorities. We'll include your tool usage statistics to better understand user patterns. Option to join user studies and calls is available too. [Give your input](command:give_feedback_to_desktop_commander)"
    ];

    // Return random message
    const randomIndex = Math.floor(Math.random() * messages.length);
    return messages[randomIndex];
  }

  /**
   * Check if user should be prompted for error feedback
   */
  async shouldPromptForErrorFeedback(): Promise<boolean> {
    const stats = await this.getStats();

    // Don't prompt if feedback already given
    if (stats.feedbackGiven) return false;

    // Check if enough time has passed since last prompt (3 days for errors)
    const now = Date.now();
    const daysSinceLastPrompt = (now - stats.lastFeedbackPrompt) / (1000 * 60 * 60 * 24);
    if (stats.lastFeedbackPrompt > 0 && daysSinceLastPrompt < 3) return false;

    // Check error patterns
    const errorRate = stats.totalToolCalls > 0 ? stats.failedCalls / stats.totalToolCalls : 0;

    // Trigger conditions:
    // - At least 5 failed calls
    // - Error rate above 30%
    // - At least 3 total sessions (not just one bad session)
    return stats.failedCalls >= 5 &&
           errorRate > 0.3 &&
           stats.totalSessions >= 3;
  }

  /**
   * Mark that user was prompted for feedback
   */
  async markFeedbackPrompted(): Promise<void> {
    const stats = await this.getStats();
    stats.lastFeedbackPrompt = Date.now();
    await this.saveStats(stats);
  }

  /**
   * Mark that user has given feedback
   */
  async markFeedbackGiven(): Promise<void> {
    const stats = await this.getStats();
    stats.feedbackGiven = true;
    await this.saveStats(stats);
  }

  /**
   * Get usage summary for debugging/admin purposes
   */
  async getUsageSummary(): Promise<string> {
    const stats = await this.getStats();
    const now = Date.now();

    const daysSinceFirst = Math.round((now - stats.firstUsed) / (1000 * 60 * 60 * 24));
    const uniqueTools = Object.keys(stats.toolCounts).length;
    const successRate = stats.totalToolCalls > 0 ?
      Math.round((stats.successfulCalls / stats.totalToolCalls) * 100) : 0;

    const topTools = Object.entries(stats.toolCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([tool, count]) => `${tool}: ${count}`)
      .join(', ');

    return `📊 **Usage Summary**
• Total calls: ${stats.totalToolCalls} (${stats.successfulCalls} successful, ${stats.failedCalls} failed)
• Success rate: ${successRate}%
• Days using: ${daysSinceFirst}
• Sessions: ${stats.totalSessions}
• Unique tools: ${uniqueTools}
• Most used: ${topTools || 'None'}
• Feedback given: ${stats.feedbackGiven ? 'Yes' : 'No'}

**By Category:**
• Filesystem: ${stats.filesystemOperations}
• Terminal: ${stats.terminalOperations}
• Editing: ${stats.editOperations}
• Search: ${stats.searchOperations}
• Config: ${stats.configOperations}
• Process: ${stats.processOperations}`;
  }
}

// Export singleton instance
export const usageTracker = new UsageTracker();
