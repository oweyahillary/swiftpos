import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const url            = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey        = process.env.SUPABASE_ANON_KEY!;

if (!url || !serviceRoleKey) {
  throw new Error('[server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// ── Service role client ───────────────────────────────────────────────────────
// Bypasses RLS. Used for ALL database queries across the server.
// NEVER call supabase.auth.signInWithPassword() on this client — doing so
// replaces the in-memory auth state with a user JWT and causes every subsequent
// query to run as that user (RLS applies, admin queries break).
export const supabase = createClient(url, serviceRoleKey, {
  auth:     { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { transport: ws },
});

// ── Auth-only client ──────────────────────────────────────────────────────────
// Used exclusively for supabase.auth.signInWithPassword() in auth.ts.
// Keeping credential verification isolated to this client ensures the service
// role singleton above is never contaminated by user sessions.
// Falls back to supabase if SUPABASE_ANON_KEY is not set (local-mode installs).
export const authClient = anonKey
  ? createClient(url, anonKey, {
      auth:     { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { transport: ws },
    })
  : supabase;
