/**
 * NewCustomerModal — A595 (owner decision D1, 2026-10-27): "cashiers and waiters must be able to CREATE a customer and
 * capture their details, including the KRA PIN". Name and phone (needed), e-mail and KRA PIN (a letter, 9 digits, a
 * letter — A123456789Z — or none). Added on the cloud with the person's own sign-in (main: customer:create); online only.
 * Loaded on demand (the POS's main chunk budget, lazy-load-a517).
 */
import { useState } from 'react';
import { posApi } from '../lib/posApi';

const KRA_RE = /^[A-Z][0-9]{9}[A-Z]$/;

export default function NewCustomerModal({ onClose, onCreated }: { onClose: () => void; onCreated?: (name: string) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [kra, setKra] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kraBad = kra.trim() !== '' && !KRA_RE.test(kra.trim());
  const save = async () => {
    if (!name.trim() || !phone.trim() || kraBad) return;
    setBusy(true); setError('');
    try {
      await posApi.order.createCustomer({ name: name.trim(), phone: phone.trim(),
        ...(email.trim() ? { email: email.trim() } : {}), ...(kra.trim() ? { kra_pin: kra.trim() } : {}) });
      onCreated?.(name.trim());
      onClose();
    } catch (e: any) { setError(e?.message ?? 'Could not add the customer.'); }
    finally { setBusy(false); }
  };
  const field = 'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="new-customer">
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-gray-700 bg-gray-900 p-5">
        <p className="text-base font-semibold text-white">New customer</p>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus />
        <input className={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (07xx xxx xxx)" inputMode="tel" />
        <input className={field} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail (optional)" type="email" />
        <input className={field} value={kra} onChange={(e) => setKra(e.target.value.toUpperCase())} placeholder="KRA PIN (optional, e.g. A123456789Z)" maxLength={11} />
        {kraBad && <p className="text-xs text-amber-400">A KRA PIN is a letter, 9 digits and a letter.</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:text-white">Cancel</button>
          <button onClick={save} disabled={busy || !name.trim() || !phone.trim() || kraBad}
            className="rounded-lg bg-action-500 px-4 py-2 text-sm font-semibold text-gray-950 disabled:opacity-40">{busy ? 'Adding…' : 'Add customer'}</button>
        </div>
      </div>
    </div>
  );
}
