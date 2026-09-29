import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './config';

export function createSupabase(cfg: AppConfig): SupabaseClient {
  return createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}
