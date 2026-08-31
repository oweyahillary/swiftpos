import { useState } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';

/**
 * Settings › Devices and printers › Kitchen display (A3 fault 1, slice 2).
 * An owner generates a branch-scoped KDS token, then opens /kds on the kitchen
 * screen and pastes it once. The token is confined server-side to that branch's
 * kitchen tickets.
 */
export default function KitchenDisplayTab() {
  const { branches } = useBranch();
  const [branchId, setBranchId] = useState('');
  const [token, setToken]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [copied, setCopied]     = useState(false);

  const generate = async () => {
    if (!branchId) { setError('Pick a branch first.'); return; }
    setBusy(true); setError(''); setToken('');
    try {
      const r = await api.post<{ token: string }>('/api/kitchen/kds-token', { branch_id: branchId });
      setToken(r.token);
    } catch (e: any) {
      setError(e?.message ?? 'Could not generate a token (owners only).');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  };

  return (
    <div className="p-6 max-w-xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Kitchen display (KDS)</h2>
        <p className="text-sm text-gray-400 mt-1">
          Generate a token for a kitchen screen, then open <code className="text-green-400">/kds</code> on
          that screen and paste it once. The token is branch-scoped — it can only read and
          advance that branch's tickets. Owners only.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Branch</label>
          <select
            value={branchId}
            onChange={e => setBranchId(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-green-500 focus:outline-none"
          >
            <option value="">Select a branch…</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <button
          onClick={generate}
          disabled={busy || !branchId}
          className="bg-green-500 hover:bg-green-400 text-gray-950 font-semibold px-4 py-2 rounded-lg disabled:opacity-40 transition-colors"
        >{busy ? 'Generating…' : 'Generate token'}</button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {token && (
        <div className="space-y-2">
          <label className="block text-xs text-gray-400">Paste this into the kitchen screen's setup:</label>
          <textarea
            readOnly
            value={token}
            rows={4}
            onFocus={e => e.currentTarget.select()}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 font-mono break-all focus:border-green-500 focus:outline-none"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={copy}
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm px-4 py-2 rounded-lg transition-colors"
            >{copied ? 'Copied ✓' : 'Copy token'}</button>
            <span className="text-xs text-gray-500">Valid for 1 year. Generating again does not revoke an earlier token.</span>
          </div>
        </div>
      )}
    </div>
  );
}
