import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { api, storeSwiftPOSToken, storeRefreshToken, clearAllTokens } from '../lib/api';

// Error codes returned by POST /api/auth/login for specific access issues
const ACCESS_ERROR_CODES: Record<string, { title: string; body: string; icon: string }> = {
  WEB_HOSTING_REQUIRED: {
    icon:  '🔒',
    title: 'Web portal access not enabled',
    body:  'Your licence covers the desktop POS app only. To access the web dashboard and cloud portal, contact SwiftPOS to upgrade your plan (KES 10,000).',
  },
  ACCOUNT_SUSPENDED: {
    icon:  '⛔',
    title: 'Account suspended',
    body:  'Your account has been suspended. Please contact SwiftPOS support to resolve this.',
  },
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [loading, setLoading]   = useState(false);

  const inputCls =
    'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
    'focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 transition-all text-sm';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setErrorCode('');
    setLoading(true);

    // ── Clear any stale SwiftPOS / POS / cashier tokens BEFORE authenticating ──
    // The access token is a single shared localStorage key, written by both the
    // dashboard owner login and the (web) POS staff logins, and getAuthHeader()
    // prefers it over the Supabase session. Wiping first guarantees no previous
    // user's token leaks into the fetches the new session will trigger.
    clearAllTokens();

    try {
      // ── Step 1: Server login FIRST — validates credentials server-side and
      //   returns the SwiftPOS JWT pair, while enforcing the web_hosting gate +
      //   suspension check. This endpoint does its own password verification, so
      //   it does NOT require a pre-existing Supabase session on the client.
      //
      //   Order matters: we must STORE the SwiftPOS token before establishing the
      //   Supabase session (step 3). signInWithPassword() fires onAuthStateChange,
      //   which makes BusinessContext / BranchContext / PermissionsContext refetch
      //   immediately. Those API routes verify the SwiftPOS JWT — if the token
      //   isn't in localStorage yet, every fetch 401s and the contexts stay empty
      //   until a manual page reload. Storing first means the very first
      //   session-triggered fetch already carries a valid token.
      let loginResponse: { mustChangePassword?: boolean; accessToken?: string; refreshToken?: string } = {};
      try {
        loginResponse = await api.post<{ mustChangePassword?: boolean }>(
          '/api/auth/login',
          { email, password },
        );
      } catch (serverErr: any) {
        // api.ts preserves the `code` field from the server JSON response
        const code = serverErr?.code;
        if (code && ACCESS_ERROR_CODES[code]) {
          setErrorCode(code);
        } else {
          // Invalid email/password (server 401) and any other access error land here.
          setError(serverErr.message ?? 'Sign in failed — please check your credentials.');
        }
        setLoading(false);
        return;
      }

      // ── Step 2: Store the SwiftPOS JWT so api.ts uses it for every subsequent
      //   request (including the context fetches triggered by step 3).
      if (loginResponse.accessToken)  storeSwiftPOSToken(loginResponse.accessToken);
      if (loginResponse.refreshToken) storeRefreshToken(loginResponse.refreshToken);

      // ── Step 3: Establish the Supabase session. ProtectedRoute and the data
      //   contexts gate on this session. It now fires with the SwiftPOS token
      //   already in place, so the contexts load correctly on first paint.
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) {
        // Token was stored but the session couldn't be created — don't leave a
        // half-authenticated state (token present, no session → bounce loop).
        clearAllTokens();
        throw new Error(signInErr.message);
      }

      // ── Step 4: Route to password change or dashboard ───────────────────────
      if (loginResponse.mustChangePassword) { navigate('/change-password'); return; }

      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message ?? 'Sign in failed — please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  // ── Render access-blocked screen ────────────────────────────────────────────
  const accessError = errorCode ? ACCESS_ERROR_CODES[errorCode] : null;
  if (accessError) {
    return (
      <div className="min-h-screen bg-[#080c14] flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="bg-[#0f172a] border border-[#1e2d45] rounded-2xl p-8 text-center space-y-5">
            <div className="text-5xl">{accessError.icon}</div>
            <div>
              <h2 className="text-white font-bold text-xl mb-2">{accessError.title}</h2>
              <p className="text-[#64748b] text-sm leading-relaxed">{accessError.body}</p>
            </div>
            {errorCode === 'WEB_HOSTING_REQUIRED' && (
              <div className="bg-[#0a1628] border border-[#1e2d45] rounded-xl p-4 text-left space-y-1">
                <p className="text-xs text-[#64748b] font-semibold uppercase tracking-wider">What you get with web hosting</p>
                <ul className="text-sm text-[#94a3b8] space-y-1 mt-2">
                  <li>✓ Cloud dashboard from any browser</li>
                  <li>✓ Multi-device POS access</li>
                  <li>✓ Real-time reports & analytics</li>
                  <li>✓ KDS on any screen</li>
                </ul>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setErrorCode(''); setError(''); }}
                className="flex-1 bg-[#1e293b] hover:bg-[#334155] text-white text-sm font-medium rounded-xl py-2.5 transition-colors"
              >
                ← Back to login
              </button>
              <a
                href="https://wa.me/254700000000?text=Hi, I'd like to upgrade my SwiftPOS account to include web hosting access."
                target="_blank"
                rel="noreferrer"
                className="flex-1 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-xl py-2.5 transition-colors text-center"
              >
                Contact SwiftPOS
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#080c14] flex items-center justify-center px-4">

      {/* Background grid */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage: `linear-gradient(rgba(59,130,246,0.03) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(59,130,246,0.03) 1px, transparent 1px)`,
          backgroundSize: '48px 48px',
        }}
      />

      <div className="w-full max-w-sm relative">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-lg bg-[#22c55e] flex items-center justify-center text-[#0f172a] font-black text-sm">S</div>
            <span className="text-xl font-bold text-white tracking-tight">SwiftPOS</span>
          </div>
          <p className="text-[#334155] text-sm">Sign in to your dashboard</p>
        </div>

        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleLogin} className="space-y-5">

            <div>
              <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">Email</label>
              <input
                className={inputCls}
                type="email"
                required
                placeholder="you@business.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-[#64748b] tracking-wide uppercase">Password</label>
                <button
                  type="button"
                  onClick={() => setShowPw(p => !p)}
                  className="text-[10px] text-[#334155] hover:text-[#64748b] transition-colors"
                >
                  {showPw ? 'hide' : 'show'}
                </button>
              </div>
              <input
                className={inputCls}
                type={showPw ? 'text' : 'password'}
                required
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl font-bold text-sm bg-[#3b82f6] hover:bg-[#2563eb] text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Signing in…
                </>
              ) : 'Sign in'}
            </button>

          </form>
        </div>

        <p className="text-center text-[#1e293b] text-xs mt-6">
          No account? Contact your SwiftPOS agent to get set up.
        </p>
      </div>
    </div>
  );
}
