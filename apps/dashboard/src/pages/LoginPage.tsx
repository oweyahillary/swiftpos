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

    // ── Clear any stale SwiftPOS token BEFORE authenticating ────────────────
    // The access token is a single shared localStorage key, written by both the
    // dashboard owner login and the (web) POS staff logins, and getAuthHeader()
    // prefers it over the Supabase session. signInWithPassword() below fires
    // Supabase's onAuthStateChange synchronously, which makes BusinessContext
    // refetch /api/business — and if a previous business's token were still in
    // localStorage at that instant (it's only overwritten in step 3), that fetch
    // would resolve to the WRONG business and cache it. Clearing first guarantees
    // the in-flight fetch falls back to the freshly-authenticated Supabase
    // session, so the correct business loads even before the new token is stored.
    // clearAllTokens() also wipes any leftover POS/cashier tokens from a
    // previous session on this device.
    clearAllTokens();

    try {
      // ── Step 1: Supabase credential check ──────────────────────────────────
      // This confirms the email/password is valid before we hit the server.
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) throw new Error(signInErr.message);

      // ── Step 2: Server login — enforces web_hosting gate + suspension check ──
      // The server will 403 with a specific code if the client hasn't paid for
      // web portal access or has been suspended by a SwiftPOS agent.
      // The response also tells us if the owner must change their password.
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
          setError(serverErr.message ?? 'Access denied');
        }
        await supabase.auth.signOut();
        setLoading(false);
        return;
      }

      // Store SwiftPOS JWT so api.ts uses it for all subsequent requests.
      // This avoids the Supabase JWT verification path on the server.
      if (loginResponse.accessToken)  storeSwiftPOSToken(loginResponse.accessToken);
      if (loginResponse.refreshToken) storeRefreshToken(loginResponse.refreshToken);

      // ── Step 3: Route to password change or dashboard ───────────────────────
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
