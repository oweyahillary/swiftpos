import { useState } from 'react';
import { posApi } from '../lib/posApi';

// EnrolPage — A158. A terminal is provisioned ONLY by a one-time enrolment code,
// never the owner's email/password (which would expose reusable dashboard
// credentials on a shared till). This is the screen a CONFIGURED-but-session-less
// terminal shows: first-run install is handled by InstallPage; this is the
// re-provision path (session lost, wiped, or a fresh amber build). Same visual
// identity as the retired LoginPage. The owner mints a single-use code in the
// portal; there is no password to type or store here.

interface Props {
  onComplete: () => void;
}

const inputCls =
  'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
  'focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 transition-all text-sm';

export default function EnrolPage({ onComplete }: Props) {
  const [businessId, setBusinessId] = useState('');
  const [code, setCode]             = useState('');
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');

  const handleEnrol = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!businessId.trim() || !code.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await posApi.auth.redeemEnrolment(businessId.trim(), code.trim());
      onComplete();
    } catch (err: any) {
      setError(err?.message ?? 'Enrolment failed — check the business ID and the code.');
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
          <p className="text-[#334155] text-sm">Activate this terminal</p>
        </div>

        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleEnrol} className="space-y-5">

            <p className="text-[#64748b] text-xs leading-relaxed">
              Enter the business ID and the one-time enrolment code from the owner portal.
              No owner password is used on a terminal.
            </p>

            <div>
              <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">Business ID</label>
              <input
                className={inputCls}
                type="text"
                required
                placeholder="business id"
                value={businessId}
                onChange={e => setBusinessId(e.target.value)}
                autoFocus
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">Enrolment code</label>
              <input
                className={inputCls + ' font-mono tracking-wider'}
                type="text"
                required
                placeholder="XXXX-XXXX"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase())}
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !businessId.trim() || !code.trim()}
              className="w-full py-3 rounded-xl font-bold text-sm bg-[#3b82f6] hover:bg-[#2563eb] text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Activating…
                </>
              ) : 'Activate'}
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
