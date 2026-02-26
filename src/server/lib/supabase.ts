import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { agentConfig } from '../agent.config';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    if (!agentConfig.supabaseUrl || !agentConfig.supabaseAnonKey) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    }
    _client = createClient(agentConfig.supabaseUrl, agentConfig.supabaseAnonKey);
  }
  return _client;
}

let _adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    if (!agentConfig.supabaseUrl || !agentConfig.supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }
    _adminClient = createClient(agentConfig.supabaseUrl, agentConfig.supabaseServiceRoleKey);
  }
  return _adminClient;
}
