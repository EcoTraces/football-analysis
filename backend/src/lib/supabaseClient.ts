import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env.js";

// Server-side client using the service role key. This bypasses Row Level
// Security by design — the backend is the sole writer of football data
// tables, and reads for those tables go through this API rather than
// directly from the frontend. Never send this key to the browser.
export function createSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}
