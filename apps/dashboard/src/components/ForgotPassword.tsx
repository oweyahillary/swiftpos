import { useState } from 'react';
import { api } from '../lib/api';
import { cleanOtpInput } from '../lib/otpTrust';

/**
 * ForgotPassword — A402: an owner resets their own password from the sign-in page (routes/auth.ts /password/forgot,
 * /password/reset; migration 124).
 *
 * Owner, 2026-10-05: "add, reset password feature". 1. the sign-in email → a 6-digit code is emailed (the same answer
 * whether or not the email is known); 2. the code and the new password twice → signed out everywhere, sign in again.
 */
export default function ForgotPassword({ initialEmail, inputCls, onDone, onBack }: {
  initialEmail: string; inputCls: string; onDone: (message: string) => void; onBack: () => void;
}) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const send = async () => {
    setBusy(true); setError('');
    try { const r = await api.post<{ message: string }>('/api/auth/password/forgot', { email }); setNote(r.message); setStep('code'); }
    catch (e: any) { setError(e?.message ?? 'Could not send the code.'); }
    finally { setBusy(false); }
  };
  const reset = async () => {
    setError('');
    if (pw !== pw2) { setError('The two passwords are not the same.'); return; }
    setBusy(true);
    try { const r = await api.post<{ message: string }>('/api/auth/password/reset', { email, code, new_password: pw }); onDone(r.message); }
    catch (e: any) { setError(e?.message ?? 'Could not reset the password.'); }
    finally { setBusy(false); }
  };

  return (
    <form className="space-y-4" data-testid="forgot-password"
      onSubmit={(e) => { e.preventDefault(); if (step === 'email') void send(); else void reset(); }}>
      <div>
        <h2 className="text-white font-semibold text-lg">Reset your password</h2>
        <p className="text-[#64748b] text-sm mt-1 leading-relaxed">
          {step === 'email' ? 'Type the email you sign in with. We will email you a 6-digit code.' : note}
        </p>
      </div>
      {step === 'email' ? (
        <input className={inputCls} type="email" required placeholder="you@business.com" value={email} autoFocus
          onChange={(e) => setEmail(e.target.value)} />
      ) : (<>
        <input className={`${inputCls} text-center tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code"
          value={code} onChange={(e) => setCode(cleanOtpInput(e.target.value))} autoFocus data-testid="reset-code" />
        <input className={inputCls} type="password" placeholder="New password (8 characters or more)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input className={inputCls} type="password" placeholder="New password again" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </>)}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}
      <button type="submit" disabled={busy || (step === 'code' && (code.length !== 6 || pw.length < 8))}
        className="w-full py-3 rounded-xl font-bold text-sm bg-swift-strong hover:bg-swift-deep text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all">
        {busy ? 'Please wait…' : step === 'email' ? 'Email me a code' : 'Set the new password'}
      </button>
      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-[#64748b] text-sm hover:text-white transition-colors">← Back to sign in</button>
        {step === 'code' && <button type="button" disabled={busy} onClick={() => void send()} className="text-[#64748b] text-sm hover:text-white transition-colors">Send a new code</button>}
      </div>
    </form>
  );
}
