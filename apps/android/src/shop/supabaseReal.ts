/**
 * supabaseReal.ts — the REAL Supabase client the owner / manager phone mode signs in through (Owner stage A). The one
 * Android build swaps the dashboard's Supabase client (apps/dashboard lib/supabase, vite.config.ts) for THIS, so the
 * dashboard's AuthContext works exactly as on the web. The Shop POS shares the build but never signs in through it (it has
 * no Supabase sign-in UI; its session is its own — deviceGrant / the staff PIN, A415), so no owner session is ever made on a till.
 *
 * The URL + anon key come from the build env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — set for the APK build, dev
 * values), the same names the web dashboard reads. The anon key is a PUBLIC, client-side key (RLS protects the data), so it
 * is safe in the APK. A placeholder fallback keeps a build with the env unset from crashing (createClient needs a URL) — in
 * that build owner sign-in simply cannot reach the cloud until the env is set.
 */
import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || 'https://placeholder.supabase.co';
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'placeholder-anon-key';

export const supabase = createClient(url, key);
