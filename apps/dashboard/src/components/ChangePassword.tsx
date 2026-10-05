import { useState } from 'react';
import { api } from '../lib/api';

/**
 * ChangePassword — A402: the signed-in owner changes their password (Settings › My sign-in). The current password is
 * checked; every other browser signed in to the account is signed out; this one stays.
 */
export default function ChangePassword() {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const field = 'w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-swift focus:outline-none';

  const save = async () => {
    setError(''); setDone('');
    if (pw !== pw2) { setError('The two new passwords are not the same.'); return; }
    setBusy(true);
    try {
      const r = await api.post<{ message: string }>('/api/auth/password/change', { current_password: cur, new_password: pw });
      setDone(r.message); setCur(''); setPw(''); setPw2('');
    } catch (e: any) { setError(e?.message ?? 'Could not change the password.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-2xl space-y-3" data-testid="change-password">
      <div>
        <h2 className="text-lg font-semibold text-white">Password</h2>
        <p className="text-sm text-gray-400">Change the password you sign in with. Forgot it? Use "Forgot password?" on the sign-in page.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} className={field} />
        <input type="password" placeholder="New password (8+)" value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
        <input type="password" placeholder="New password again" value={pw2} onChange={(e) => setPw2(e.target.value)} className={field} />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {done && <p className="text-sm text-gray-300">{done}</p>}
      <button disabled={busy || !cur || pw.length < 8} onClick={() => void save()}
        className="rounded-xl bg-swift px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">
        {busy ? 'Saving…' : 'Change password'}
      </button>
    </div>
  );
}
