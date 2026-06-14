import { useState } from 'react';
import { posApi } from '../lib/posApi';

// Owner/terminal login — same visual identity as the web dashboard's
// LoginPage (navy palette, background grid, logo block, blue CTA), with the
// desktop's auth flow underneath: a single IPC call to the configured server
// (no Supabase client on the till — the main process owns all network auth).

interface Props {
  onLogin: (session: { user: any; business: any }) => void;
}

const inputCls =
  'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
  'focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 transition-all text-sm';

export default function LoginPage({ onLogin }: Props) {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const handleLogin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || !password || loading) return;
    setLoading(true);
    setError('');

    try {
      const session = await posApi.auth.login(email.trim(), password);
      onLogin(session);
    } catch (err: any) {
      setError(err.message ?? 'Sign in failed — please check your credentials.');
      setLoading(false);
    }
  };

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
          <p className="text-[#334155] text-sm">Sign in to this terminal</p>
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
              disabled={loading || !email.trim() || !password}
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
          SwiftPOS v{posApi.version} · {posApi.platform} · offline-first terminal
        </p>
      </div>
    </div>
  );
}
