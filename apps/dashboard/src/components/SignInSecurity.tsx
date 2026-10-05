import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * SignInSecurity — A391: my sign-in code, for owners (Settings › Users and access › My sign-in) and managers (Manager
 * dashboard › My sign-in). Both enter a 6-digit code at every web sign-in — A398: when the admin portal has turned
 * 'Sign-in codes' on for the client (off by default).
 *
 * Owner, 2026-10-04: "OTP enabling both admin portal and dashboard" — by email or an authenticator app, "Both, user
 * picks". Email is the default (nothing to set up); an authenticator app is set up here from a QR code.
 */
interface Info { method: 'email' | 'totp'; email: string; enabled?: boolean }
interface Setup { qr_svg: string; secret: string; setup_token: string }

export default function SignInSecurity() {
  const [info, setInfo] = useState<Info | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = () => api.get<Info>('/api/auth/otp').then(setInfo).catch((e) => setError(e?.message ?? 'Could not load.'));
  useEffect(() => { void load(); }, []);

  const start = async () => {
    setBusy(true); setError(''); setDone(''); setCode('');
    try { setSetup(await api.post<Setup>('/api/auth/otp/totp/start', {})); }
    catch (e: any) { setError(e?.message ?? 'Could not start.'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!setup) return;
    setBusy(true); setError('');
    try {
      await api.post('/api/auth/otp/totp/confirm', { setup_token: setup.setup_token, code });
      setSetup(null); setCode(''); setDone('Authenticator app is on. Use its code next time you sign in.');
      await load();
    } catch (e: any) { setError(e?.message ?? 'That code is not right.'); }
    finally { setBusy(false); }
  };
  const useEmail = async () => {
    if (!window.confirm('Get your sign-in code by email instead of the authenticator app?')) return;
    setBusy(true); setError('');
    try { await api.post('/api/auth/otp/email', {}); setDone('You will get your sign-in code by email.'); await load(); }
    catch (e: any) { setError(e?.message ?? 'Could not save.'); }
    finally { setBusy(false); }
  };

  const option = (k: Info['method'], title: string, text: string) => {
    const on = info?.method === k;
    return (
      <div key={k} className={`flex gap-3 rounded-xl border px-4 py-3 ${on ? 'border-swift bg-swift/10' : 'border-gray-700'}`}>
        <span className={`mt-1 h-3.5 w-3.5 flex-shrink-0 rounded-full border-2 ${on ? 'border-swift bg-swift' : 'border-gray-500'}`} />
        <div>
          <div className="text-sm font-semibold text-white">{title}{on ? ' — in use' : ''}</div>
          <div className="mt-0.5 text-xs text-gray-400">{text}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-2xl space-y-4" data-testid="signin-security">
      <div>
        <h2 className="text-lg font-semibold text-white">My sign-in</h2>
        {/* A398: the admin portal turns sign-in codes on or off per client. */}
        <p className="text-sm text-gray-400">{info && info.enabled === false
          ? 'Sign-in codes are off for this business — you sign in with your password or PIN only. ZapTill support can turn them on; choose how you would get your code below.'
          : 'Every web sign-in asks for a 6-digit code as well as your password or PIN.'}</p>
      </div>
      {info && (
        <div className="grid gap-2">
          {option('email', 'Email', `A code is emailed to ${info.email} each time you sign in.`)}
          {option('totp', 'Authenticator app', 'Google or Microsoft Authenticator on your phone — works even when email is slow.')}
        </div>
      )}
      {setup ? (
        <div className="flex flex-wrap items-start gap-5 rounded-xl border border-gray-700 bg-gray-800/50 p-4">
          <div className="w-44 flex-shrink-0 overflow-hidden rounded-lg" data-testid="otp-qr"
            dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
          <div className="min-w-[220px] flex-1 space-y-3">
            <p className="text-xs leading-relaxed text-gray-400">
              1. In the authenticator app tap <b className="text-white">+</b> and scan this code.<br />
              Can't scan? Enter this key: <code className="break-all text-white">{setup.secret}</code><br />
              2. Type the 6-digit code the app shows for ZapTill.
            </p>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} placeholder="123456"
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))}
              className="w-44 rounded-xl border border-gray-700 bg-gray-900 px-4 py-2 text-lg tracking-[0.4em] text-white focus:border-swift focus:outline-none" />
            <div className="flex gap-2">
              <button disabled={busy || code.length !== 6} onClick={confirm}
                className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">
                {busy ? 'Checking…' : 'Turn on'}
              </button>
              <button disabled={busy} onClick={() => { setSetup(null); setError(''); }}
                className="rounded-xl px-4 py-2 text-sm text-gray-400 hover:bg-gray-700 hover:text-white">Cancel</button>
            </div>
          </div>
        </div>
      ) : info && (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={start}
            className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">
            {info.method === 'totp' ? 'Set up a new phone' : 'Use an authenticator app'}
          </button>
          {info.method === 'totp' && (
            <button disabled={busy} onClick={useEmail}
              className="rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:text-white">Use email instead</button>
          )}
        </div>
      )}
      {done && <p className="text-sm text-swift-text">{done}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <p className="text-xs text-gray-500">Lost your phone? Ask the owner (or ZapTill support, for an owner) to reset your sign-in code to email.</p>
    </div>
  );
}
