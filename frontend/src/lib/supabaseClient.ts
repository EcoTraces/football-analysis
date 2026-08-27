import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

// null when unconfigured — every caller must handle that explicitly rather
// than this module silently disabling auth or throwing at import time. The
// anon key is safe to ship to the browser; RLS is what actually restricts
// what it can do (see supabase/migrations/0001_init.sql, 0004_*.sql).
export const supabase: SupabaseClient | null = isSupabaseConfigured ? createClient(url!, anonKey!) : null;
