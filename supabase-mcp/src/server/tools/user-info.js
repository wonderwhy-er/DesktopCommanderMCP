/**
 * User information tool - gets current user data from Supabase
 */
import { z } from 'zod';

export class UserInfoTool {
  static getDefinition() {
    return {
      name: 'user_info',
      description: 'Get current user information and session details',
      inputSchema: z.object({
        include_metadata: z.boolean().default(true).describe('Include user metadata in response'),
        include_session: z.boolean().default(false).describe('Include session information')
      })
    };
  }

  static async execute(params, user, supabase) {
    const { include_metadata = true, include_session = false } = params;

    try {
      // Get basic user info
      const userInfo = {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        updated_at: user.updated_at,
        last_sign_in_at: user.last_sign_in_at,
        email_confirmed_at: user.email_confirmed_at
      };

      // Include metadata if requested
      if (include_metadata) {
        userInfo.user_metadata = user.user_metadata || {};
        userInfo.app_metadata = user.app_metadata || {};
      }

      // Include session info if requested
      if (include_session) {
        try {
          const { data: sessions, error: sessionError } = await supabase
            .from('mcp_sessions')
            .select('*')
            .eq('user_id', user.id)
            .eq('is_active', true)
            .order('created_at', { ascending: false })
            .limit(5);

          if (!sessionError) {
            userInfo.active_sessions = sessions;
          }
        } catch (error) {
          // Session info is optional, don't fail if we can't get it
          userInfo.session_error = 'Could not retrieve session information';
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(userInfo, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to get user information: ${error.message}`);
    }
  }
}