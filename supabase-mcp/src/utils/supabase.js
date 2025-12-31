import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Create Supabase client for public operations (publishable key)
 */
export function createSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error('Missing Supabase configuration. Check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY environment variables.');
  }

  return createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Create Supabase client with secret key for admin operations
 */
export function createSupabaseServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error('Missing Supabase service configuration. Check SUPABASE_URL and SUPABASE_SECRET_KEY environment variables.');
  }

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Validate and get user from JWT token
 */
export async function getUserFromToken(token, supabase = null) {
  if (!supabase) {
    supabase = createSupabaseClient();
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error) {
      throw new Error(`Token validation failed: ${error.message}`);
    }

    if (!user) {
      throw new Error('No user found for token');
    }

    return user;
  } catch (error) {
    throw new Error(`Authentication failed: ${error.message}`);
  }
}