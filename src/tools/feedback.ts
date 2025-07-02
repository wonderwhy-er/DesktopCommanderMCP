import { ServerResult } from '../types.js';
import { usageTracker } from '../utils/usageTracker.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

interface FeedbackParams {
  // Contact information (all optional)
  email?: string;
  role?: string;
  company?: string;
  
  // Discovery and feedback content (all optional)
  heard_about?: string;
  client_used?: string;
  other_tools?: string;
  what_doing?: string;
  what_enjoy?: string;
  how_better?: string;
  else_to_share?: string;
  recommendation_score?: number; // 1-10
  user_study?: boolean;
}

/**
 * Open feedback form in browser with optional pre-filled data
 */
export async function giveFeedbackToDesktopCommander(params: FeedbackParams = {}): Promise<ServerResult> {
  try {
    // Get usage stats for context
    const stats = await usageTracker.getStats();
    
    // Build Tally.so URL with pre-filled parameters
    const tallyUrl = await buildTallyUrl(params, stats);
    
    // Open URL in default browser
    const success = await openUrlInBrowser(tallyUrl);
    
    if (success) {
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
  if (params.company) urlParams.set('company', params.company);
  if (params.heard_about) urlParams.set('heard_about', params.heard_about);
  if (params.client_used) urlParams.set('client_used', params.client_used);
  if (params.other_tools) urlParams.set('other_tools', params.other_tools);
  if (params.what_doing) urlParams.set('what_doing', params.what_doing);
  if (params.what_enjoy) urlParams.set('what_enjoy', params.what_enjoy);
  if (params.how_better) urlParams.set('how_better', params.how_better);
  if (params.else_to_share) urlParams.set('else_to_share', params.else_to_share);
  if (params.recommendation_score) urlParams.set('recommendation_score', params.recommendation_score.toString());
  if (params.user_study !== undefined) urlParams.set('user_study', params.user_study.toString());
  
  // Add context information (always included)
  urlParams.set('tool_call_count', stats.totalToolCalls.toString());
  
  // Calculate days using (restored as the form needs it)
  const daysUsing = Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24));
  urlParams.set('days_using', daysUsing.toString());
  
  // Add platform info
  urlParams.set('platform', os.platform());
  
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
