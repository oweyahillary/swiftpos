import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';

export default function ForcePasswordChangePage() {
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const valid = newPassword.length >= 8 && newPassword === confirm;

  const strengthScore = newPassword.length >= 12 ? 4 : newPassword.length >= 10 ? 3 : newPassword.length >= 8 ? 2 : newPassword.length >= 4 ? 1 : 0;
  const strengthLabel = ['', 'Weak', 'Acceptable', 'Good', 'Strong'][strengthScore];
  const strengthColor = ['', '#ef4444', '#f59e0b', '#3b82f6', '#22c55e'][strengthScore];

  async function handleSubmit() {
    if (!valid) return;
    setError('');
    setLoading(true);

    try {
      // Step 1: Update password in Supabase auth (the critical step)
      const { error: updateErr } = await supabase.auth.updateUser({ password: newPassword });
      if (updateErr) throw new Error(updateErr.message);

      // Step 2: Clear the must_change_password flag — NON-FATAL.
      // If this fails (e.g. server not restarted yet), we still navigate.
      // The user's password was changed in step 1 which is what matters.
      try {
        await api.patch('/api/auth/me', { must_change_password: false });
      } catch {
        console.warn('[ForcePasswordChange] Could not clear must_change_password — proceeding anyway');
      }

      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message ?? 'Could not update password — please try again.');
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    'w-full bg-[#0f172a] border border-[#1e293b] rounded-xl px-4 py-3 text-white placeholder-[#334155] ' +
    'focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6]/30 transition-all text-sm';

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
          <p className="text-[#334155] text-sm">Welcome — let's secure your account</p>
        </div>

        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-8 shadow-2xl space-y-5">

          {/* Notice */}
          <div className="flex items-start gap-3 px-4 py-3 bg-[#f59e0b]/5 border border-[#f59e0b]/20 rounded-xl">
            <span className="text-yellow-400 text-base flex-shrink-0 mt-0.5">🔐</span>
            <p className="text-xs text-[#94a3b8] leading-relaxed">
              Your account was set up by a SwiftPOS agent. Please choose a new private password before continuing.
            </p>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-white">Set your password</h2>
            <p className="text-[#475569] text-xs mt-1">Choose something only you know.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">
              New password
            </label>
            <div className="relative">
              <input
                className={inputCls + ' pr-14'}
                type={showPw ? 'text' : 'password'}
                placeholder="Min. 8 characters"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPw(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#334155] hover:text-[#64748b] transition-colors"
              >
                {showPw ? 'hide' : 'show'}
              </button>
            </div>

            {/* Strength bar */}
            {newPassword.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="flex gap-1">
                  {[1,2,3,4].map(i => (
                    <div
                      key={i}
                      className="h-1 flex-1 rounded-full transition-all duration-300"
                      style={{ background: strengthScore >= i ? strengthColor : '#1e293b' }}
                    />
                  ))}
                </div>
                <p className="text-[10px]" style={{ color: strengthColor }}>{strengthLabel}</p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-[#64748b] mb-1.5 tracking-wide uppercase">
              Confirm password
            </label>
            <input
              className={inputCls + (confirm && newPassword !== confirm ? ' border-red-500/40' : '')}
              type={showPw ? 'text' : 'password'}
              placeholder="Repeat new password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
            />
            {confirm && newPassword !== confirm && (
              <p className="text-[10px] text-red-400 mt-1.5">Passwords don't match</p>
            )}
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <button
            disabled={loading || !valid}
            onClick={handleSubmit}
            className="w-full py-3 rounded-xl font-bold text-sm bg-[#22c55e] hover:bg-[#16a34a] text-[#0f172a] disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                </svg>
                Updating…
              </>
            ) : (
              'Save password & continue →'
            )}
          </button>

        </div>

        <p className="text-center text-[#1e293b] text-xs mt-6">
          You can update your password anytime in Settings → My account
        </p>
      </div>
    </div>
  );
}
