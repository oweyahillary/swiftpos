import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/**
 * A DEDICATED, session-less Supabase client for the /kds display's realtime channel.
 *
 * A191: the shared `supabase` client persists a GoTrue session and AuthContext reacts
 * to its auth-state changes by setting the app session. When /kds subscribed to
 * realtime through that shared client, the realtime connection could trigger a GoTrue
 * sign-out/refresh-failure → AuthContext nulled the session → the owner was logged out
 * app-wide. This client persists NO session and never auto-refreshes, so its realtime
 * activity cannot touch the owner's dashboard session.
 */
export const kdsRealtime = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
