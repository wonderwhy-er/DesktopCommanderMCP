import { ServerResult } from '../types.js';
import { usageTracker } from '../utils/usageTracker.js';
import { capture } from '../utils/capture.js';
import { configManager } from '../config-manager.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

interface FeedbackParams {
  // No user parameters - form will be filled manually
  // Only auto-filled usage statistics remain
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
      total_calls: stats.totalToolCalls,
      successful_calls: stats.successfulCalls,
      failed_calls: stats.failedCalls,
      days_since_first_use: Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24)),
      total_sessions: stats.totalSessions,
      platform: os.platform(),
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
              `You can still access our feedback form directly at: https://tally.so/r/mKqoKg\n\n` +
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
  const baseUrl = 'https://tally.so/r/mKqoKg';
  const urlParams = new URLSearchParams();
  
  // Only auto-filled hidden fields remain
  urlParams.set('tool_call_count', stats.totalToolCalls.toString());
  
  // Calculate days using
  const daysUsing = Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24));
  urlParams.set('days_using', daysUsing.toString());
  
  // Add platform info
  urlParams.set('platform', os.platform());
  
  // Add client_id from analytics config
  try {
    const clientId = await configManager.getValue('clientId') || 'unknown';
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
