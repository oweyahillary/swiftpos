/**
 * EtimsSettingsPage — KRA eTIMS configuration & fiscalisation health.
 *
 * Lets an owner: toggle eTIMS on/off, choose sandbox/production + VSCU/OSCU,
 * enter the branch ID / device serial, register the control unit with KRA,
 * see pending/failed/signed counts, browse recent fiscal records, and trigger
 * a manual retry. Transmission itself happens server-side.
 */

import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import BulkItemCodeModal from './BulkItemCodeModal';

interface EtimsConfig {
  branch_id: string;
  environment: 'sandbox' | 'production';
  mode: 'vscu' | 'oscu';
  bhf_id: string | null;
  device_serial: string | null;
  sdc_id: string | null;
  status: 'pending' | 'registered' | 'disabled';
  registered_at: string | null;
}
interface ConfigResponse {
  enabled: boolean;
  taxPin: string | null;
  onboarded: boolean;
  config: EtimsConfig | null;
}
interface StatusResponse {
  config: Partial<EtimsConfig> | null;
  counts: Record<string, number>;
}
interface InvoiceRow {
  id: string;
  order_id: string;
  invoice_type: 'sale' | 'credit';
  status: 'pending' | 'sent' | 'signed' | 'failed' | 'skipped';
  invoice_no: number | null;
  kra_receipt_no: string | null;
  error: string | null;
  created_at: string;
  signed_at: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  signed:  'text-green-400',
  pending: 'text-yellow-400',
  sent:    'text-blue-400',
  failed:  'text-red-400',
  skipped: 'text-gray-500',
};

export default function EtimsSettingsPage() {
  const { activeBranch } = useBranch();
  const branchId = activeBranch?.id;

  const [enabled, setEnabled] = useState(false);
  const [taxPin, setTaxPin] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('sandbox');
  const [mode, setMode] = useState<'vscu' | 'oscu'>('vscu');
  const [bhfId, setBhfId] = useState('');
  const [deviceSerial, setDeviceSerial] = useState('');
  const [status, setStatus] = useState<EtimsConfig['status']>('pending');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const cfg = await api.get<ConfigResponse>(`/api/etims/config?branch_id=${branchId}`);
      setEnabled(cfg.enabled);
      setTaxPin(cfg.taxPin);
      if (cfg.config) {
        setEnvironment(cfg.config.environment);
        setMode(cfg.config.mode);
        setBhfId(cfg.config.bhf_id ?? '');
        setDeviceSerial(cfg.config.device_serial ?? '');
        setStatus(cfg.config.status);
      }
      const st = await api.get<StatusResponse>(`/api/etims/status?branch_id=${branchId}`);
      setCounts(st.counts ?? {});
      const inv = await api.get<InvoiceRow[]>(`/api/etims/invoices?branch_id=${branchId}`);
      setInvoices(inv ?? []);
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Failed to load eTIMS settings' });
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!branchId) return;
    setSaving(true); setMsg(null);
    try {
      await api.put('/api/etims/config', {
        branch_id: branchId, enabled, environment, mode,
        bhf_id: bhfId.trim() || null, device_serial: deviceSerial.trim() || null,
      });
      setMsg({ kind: 'ok', text: 'Settings saved' });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Save failed' });
    } finally { setSaving(false); }
  };

  const register = async () => {
    if (!branchId) return;
    setRegistering(true); setMsg(null);
    try {
      await api.post(`/api/etims/branches/${branchId}/register`, { bhf_id: bhfId.trim(), device_serial: deviceSerial.trim() });
      setMsg({ kind: 'ok', text: 'Branch registered with KRA' });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Registration failed — check sandbox credentials' });
    } finally { setRegistering(false); }
  };

  const retry = async () => {
    setRetrying(true); setMsg(null);
    try {
      const r = await api.post<{ retried: number }>('/api/etims/retry', {});
      setMsg({ kind: 'ok', text: `Reprocessed ${r.retried} invoice(s)` });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message ?? 'Retry failed' });
    } finally { setRetrying(false); }
  };

  if (!branchId) return <div className="p-6 text-gray-400">Select a branch to configure eTIMS.</div>;

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-bold text-white mb-1">KRA eTIMS</h1>
      <p className="text-sm text-gray-400 mb-6">Fiscalisation settings for {activeBranch?.name}.</p>

      {msg && (
        <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${msg.kind === 'ok' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <>
          {/* Enable + PIN */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white font-medium">Enable eTIMS fiscalisation</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Business PIN: {taxPin || <span className="text-yellow-500">not set — add it in Business settings</span>}
                </p>
              </div>
              <button
                onClick={() => setEnabled(v => !v)}
                className={`w-12 h-6 rounded-full relative transition-colors ${enabled ? 'bg-green-500' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${enabled ? 'left-6' : 'left-0.5'}`} />
              </button>
            </div>
          </div>

          {/* Config */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Environment</label>
              <select value={environment} onChange={e => setEnvironment(e.target.value as any)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white">
                <option value="sandbox">Sandbox (testing)</option>
                <option value="production">Production (live)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Mode</label>
              <select value={mode} onChange={e => setMode(e.target.value as any)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white">
                <option value="vscu">VSCU (offline-tolerant)</option>
                <option value="oscu">OSCU (always online)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Branch ID (bhfId)</label>
              <input value={bhfId} onChange={e => setBhfId(e.target.value)} placeholder="00"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Device serial</label>
              <input value={deviceSerial} onChange={e => setDeviceSerial(e.target.value)} placeholder="from KRA"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600" />
            </div>
          </div>

          <div className="flex items-center gap-3 mb-6">
            <button onClick={save} disabled={saving}
              className="px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button onClick={register} disabled={registering}
              className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium">
              {registering ? 'Registering…' : 'Register control unit'}
            </button>
            <span className={`text-sm ${status === 'registered' ? 'text-green-400' : 'text-gray-500'}`}>
              {status === 'registered' ? '● Registered' : '○ Not registered'}
            </span>
            <button onClick={() => setShowBulk(true)}
              className="ml-auto px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg text-sm font-medium">
              Bulk item codes
            </button>
          </div>

          {/* Health */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-white font-medium">Fiscalisation health</p>
              <button onClick={retry} disabled={retrying}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white rounded-lg text-xs">
                {retrying ? 'Retrying…' : 'Retry pending'}
              </button>
            </div>
            <div className="flex gap-4 text-sm">
              {['signed', 'pending', 'sent', 'failed', 'skipped'].map(s => (
                <div key={s}>
                  <span className={`font-bold ${STATUS_COLORS[s]}`}>{counts[s] ?? 0}</span>
                  <span className="text-gray-500 ml-1 capitalize">{s}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent invoices */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-white font-medium mb-3">Recent fiscal records</p>
            {invoices.length === 0 ? (
              <p className="text-gray-500 text-sm">No records yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-left text-xs">
                    <th className="pb-2">No.</th><th className="pb-2">Type</th><th className="pb-2">Status</th>
                    <th className="pb-2">KRA Receipt</th><th className="pb-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(r => (
                    <tr key={r.id} className="border-t border-gray-800">
                      <td className="py-2 text-gray-300">{r.invoice_no ?? '—'}</td>
                      <td className="py-2 text-gray-400 capitalize">{r.invoice_type}</td>
                      <td className={`py-2 capitalize ${STATUS_COLORS[r.status]}`}>{r.status}</td>
                      <td className="py-2 text-gray-300">{r.kra_receipt_no ?? (r.error ? <span className="text-red-400" title={r.error}>error</span> : '—')}</td>
                      <td className="py-2 text-gray-500">{new Date(r.created_at).toLocaleString('en-KE')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {showBulk && <BulkItemCodeModal onClose={() => setShowBulk(false)} />}
    </div>
  );
}
