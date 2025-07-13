import { ServerResult } from '../types.js';
import { usageTracker } from '../utils/usageTracker.js';
import { capture } from '../utils/capture.js';
import { configManager } from '../config-manager.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

interface FeedbackParams {
  // Page 1: Let's get to know you
  role?: string;
  department?: string;
  what_doing?: string; // What's your primary focus at work?
  company_url?: string;
  coding_comfort?: string;
  heard_about?: string;
  
  // Page 2: Understanding Your Usage
  problem_solving?: string; // What problem were you trying to solve when you started using Desktop Commander?
  workflow?: string; // What's your typical workflow with Desktop Commander?
  task?: string; // Can you describe a task or use case where Desktop Commander helped you significantly?
  aha_moment?: string; // Was there a moment or feature that made everything "click"?
  other_tools?: string; // What other AI tools or agents are you currently using?
  ease_of_start?: number; // How easy was it to get started? (0-10)
  
  // Page 3: Feedback & Improvements
  confusing_parts?: string; // Is there anything you found confusing or unexpected?
  how_better?: string; // What would you improve or change?
  else_to_share?: string; // Is there anything else you would like to share?
  
  // Page 4: Final Thoughts
  recommendation_score?: number; // How likely to recommend? (0-10)
  user_study?: string; // Would you be open to participating in user study?
  email?: string;
  
  // Page 5: Usage Statistics (auto-filled, but can be overridden)
  tool_call_count?: string;
  days_using?: string;
  platform?: string;
  client_used?: string;
}

/**
 * Open feedback form in browser with optional pre-filled data
 */
export async function giveFeedbackToDesktopCommander(params: FeedbackParams = {}): Promise<ServerResult> {
  try {
    // Get usage stats for context
    const stats = await usageTracker.getStats();
    
    // Capture feedback tool usage event
    await capture('feedback_tool_called', {
      // Page 1 parameters
      has_role: !!params.role,
      has_department: !!params.department,
      has_what_doing: !!params.what_doing,
      has_company_url: !!params.company_url,
      has_coding_comfort: !!params.coding_comfort,
      has_heard_about: !!params.heard_about,
      
      // Page 2 parameters
      has_problem_solving: !!params.problem_solving,
      has_workflow: !!params.workflow,
      has_task: !!params.task,
      has_aha_moment: !!params.aha_moment,
      has_other_tools: !!params.other_tools,
      has_ease_of_start: params.ease_of_start !== undefined,
      
      // Page 3 parameters
      has_confusing_parts: !!params.confusing_parts,
      has_how_better: !!params.how_better,
      has_else_to_share: !!params.else_to_share,
      
      // Page 4 parameters
      has_recommendation_score: params.recommendation_score !== undefined,
      has_user_study: !!params.user_study,
      has_email: !!params.email,
      
      // Page 5 parameters
      has_client_used: !!params.client_used,
      
      // Usage context
      total_calls: stats.totalToolCalls,
      successful_calls: stats.successfulCalls,
      failed_calls: stats.failedCalls,
      days_since_first_use: Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24)),
      total_sessions: stats.totalSessions,
      platform: os.platform(),
      params_provided: Object.keys(params).length
    });
    
    // Build Tally.so URL with pre-filled parameters
    const tallyUrl = await buildTallyUrl(params, stats);
    
    // Open URL in default browser
    const success = await openUrlInBrowser(tallyUrl);
    
    if (success) {
      // Capture successful browser opening
      await capture('feedback_form_opened_successfully', {
        total_calls: stats.totalToolCalls,
        platform: os.platform()
      });
      
      // Mark that user has given feedback (or at least opened the form)
      await usageTracker.markFeedbackGiven();
      
      return {
        content: [{
          type: "text",
          text: `🎉 **Feedback form opened in your browser!**\n\n` +
                `Thank you for taking the time to share your experience with Desktop Commander. ` +
                `Your feedback helps us build better features and improve the tool for everyone.\n\n` +
                `The form has been pre-filled with the information you provided. ` +
                `You can modify or add any additional details before submitting.\n\n` +
                `**Form URL**: ${tallyUrl.length > 100 ? tallyUrl.substring(0, 100) + '...' : tallyUrl}`
        }]
      };
    } else {
      // Capture browser opening failure
      await capture('feedback_form_open_failed', {
        total_calls: stats.totalToolCalls,
        platform: os.platform(),
        error_type: 'browser_open_failed'
      });
      
      return {
        content: [{
          type: "text",
          text: `⚠️ **Couldn't open browser automatically**\n\n` +
                `Please copy and paste this URL into your browser to access the feedback form:\n\n` +
                `${tallyUrl}\n\n` +
                `The form has been pre-filled with your information. Thank you for your feedback!`
        }]
      };
    }
    
  } catch (error) {
    // Capture error event
    await capture('feedback_tool_error', {
      error_message: error instanceof Error ? error.message : String(error),
      error_type: error instanceof Error ? error.constructor.name : 'unknown'
    });
    
    return {
      content: [{
        type: "text",
        text: `❌ **Error opening feedback form**: ${error instanceof Error ? error.message : String(error)}\n\n` +
              `You can still access our feedback form directly at: https://tally.so/r/mYB6av\n\n` +
              `We appreciate your willingness to provide feedback!`
      }],
      isError: true
    };
  }
}

/**
 * Build Tally.so URL with pre-filled parameters
 */
async function buildTallyUrl(params: FeedbackParams, stats: any): Promise<string> {
  const baseUrl = 'https://tally.so/r/mYB6av';
  const urlParams = new URLSearchParams();
  
  // Page 1: Let's get to know you
  if (params.role) urlParams.set('role', params.role);
  if (params.department) urlParams.set('department', params.department);
  if (params.what_doing) urlParams.set('what_doing', params.what_doing);
  if (params.company_url) urlParams.set('company_url', params.company_url);
  if (params.coding_comfort) urlParams.set('coding_comfort', params.coding_comfort);
  if (params.heard_about) urlParams.set('heard_about', params.heard_about);
  
  // Page 2: Understanding Your Usage
  if (params.problem_solving) urlParams.set('problem_solving', params.problem_solving);
  if (params.workflow) urlParams.set('workflow', params.workflow);
  if (params.task) urlParams.set('task', params.task);
  if (params.aha_moment) urlParams.set('aha_moment', params.aha_moment);
  if (params.other_tools) urlParams.set('other_tools', params.other_tools);
  if (params.ease_of_start !== undefined) urlParams.set('ease_of_start', params.ease_of_start.toString());
  
  // Page 3: Feedback & Improvements
  if (params.confusing_parts) urlParams.set('confusing_parts', params.confusing_parts);
  if (params.how_better) urlParams.set('how_better', params.how_better);
  if (params.else_to_share) urlParams.set('else_to_share', params.else_to_share);
  
  // Page 4: Final Thoughts
  if (params.recommendation_score !== undefined) urlParams.set('recommendation_score', params.recommendation_score.toString());
  if (params.user_study) urlParams.set('user_study', params.user_study);
  if (params.email) urlParams.set('email', params.email);
  
  // Page 5: Usage Statistics (always included)
  urlParams.set('tool_call_count', params.tool_call_count || stats.totalToolCalls.toString());
  
  // Calculate days using (restored as the form needs it)
  const daysUsing = Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24));
  urlParams.set('days_using', params.days_using || daysUsing.toString());
  
  // Add platform info
  urlParams.set('platform', params.platform || os.platform());
  
  // Add client info
  if (params.client_used) {
    urlParams.set('client_used', params.client_used);
  }
  
  // Add client_id from analytics config
  try {
    const telemetryConfig = await configManager.getValue('telemetryConfig');
    const clientId = telemetryConfig?.clientId || 'unknown';
    urlParams.set('client_id', clientId);
  } catch (error) {
    // Fallback if config read fails
    urlParams.set('client_id', 'unknown');
  }
  
  return `${baseUrl}?${urlParams.toString()}`;
}

/**
 * Open URL in default browser (cross-platform)
 */
async function openUrlInBrowser(url: string): Promise<boolean> {
  try {
    const platform = os.platform();
    
    let command: string;
    switch (platform) {
      case 'darwin':  // macOS
        command = `open "${url}"`;
        break;
      case 'win32':   // Windows
        command = `start "" "${url}"`;
        break;
      default:        // Linux and others
        command = `xdg-open "${url}"`;
        break;
    }
    
    await execAsync(command);
    return true;
  } catch (error) {
    console.error('Failed to open browser:', error);
    return false;
  }
}
