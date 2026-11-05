/**
 * supabaseStub.ts — stands in for the dashboard's Supabase client (apps/dashboard/src/lib/supabase.ts) inside the Shop POS
 * (vite.config.ts swaps it). Supabase is the owner's web sign-in; a Shop POS signs in as itself (A415) and its people
 * with their PINs, so there is never a Supabase session here — and no Supabase address or key is built into the APK.
 */
const noSession = { data: { session: null }, error: null };

export const supabase = {
  auth: {
    getSession: async () => noSession,
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signOut: async () => ({ error: null }),
  },
};
