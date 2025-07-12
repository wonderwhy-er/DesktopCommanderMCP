import { ServerResult } from '../types.js';
import { usageTracker } from '../utils/usageTracker.js';
import { capture } from '../utils/capture.js';
import { configManager } from '../config-manager.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

interface FeedbackParams {
  // Contact information (all optional)
  email?: string;
  role?: string;
  company_url?: string;
  department?: string;
  
  // Discovery and feedback content (all optional)
  heard_about?: string;
  client_used?: string;
  other_tools?: string;
  what_doing?: string;
  workflow?: string;
  task?: string;
  how_better?: string;
  else_to_share?: string;
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
      has_email: !!params.email,
      has_role: !!params.role,
      has_company_url: !!params.company_url,
      has_department: !!params.department,
      has_workflow: !!params.workflow,
      has_task: !!params.task,
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
              `You can still access our feedback form directly at: https://tally.so/r/desktop-commander-feedback\n\n` +
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
  const baseUrl = 'https://tally.so/r/w2R72e';
  const urlParams = new URLSearchParams();
  
  // Add user-provided parameters (if any)
  if (params.email) urlParams.set('email', params.email);
  if (params.role) urlParams.set('role', params.role);
  if (params.company_url) urlParams.set('company_url', params.company_url);
  if (params.department) urlParams.set('department', params.department);
  if (params.heard_about) urlParams.set('heard_about', params.heard_about);
  if (params.client_used) urlParams.set('client_used', params.client_used);
  if (params.other_tools) urlParams.set('other_tools', params.other_tools);
  if (params.what_doing) urlParams.set('what_doing', params.what_doing);
  if (params.workflow) urlParams.set('workflow', params.workflow);
  if (params.task) urlParams.set('task', params.task);
  if (params.how_better) urlParams.set('how_better', params.how_better);
  if (params.else_to_share) urlParams.set('else_to_share', params.else_to_share);
  
  // Add context information (always included)
  urlParams.set('tool_call_count', stats.totalToolCalls.toString());
  
  // Calculate days using (restored as the form needs it)
  const daysUsing = Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24));
  urlParams.set('days_using', daysUsing.toString());
  
  // Add platform info
  urlParams.set('platform', os.platform());
  
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
