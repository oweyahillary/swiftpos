import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

// A139: per-branch receipt text + hours that override the business default for a
// franchise branch. A branch either INHERITS the business default (no row) or
// OVERRIDES it (a row). The till resolves this server-side in /pos/init.

const TEXT_FIELDS = [
  { key: 'receipt_header', label: 'Receipt header' },
  { key: 'receipt_footer', label: 'Receipt footer' },
] as const;

export default function BranchReceiptOverrides({ branchId }: { branchId: string }) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [defaults, setDefaults]   = useState<Record<string, string>>({});
  const [loading, setLoading]     = useState(true);
  const [toast, setToast]         = useState('');

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get<Record<string, string>>(`/api/branches/${branchId}/settings`),
      api.get<Array<{ key: string; value: string }>>(`/api/business/settings`),
    ]).then(([ov, biz]) => {
      if (!live) return;
      setOverrides(ov ?? {});
      const d: Record<string, string> = {};
      for (const r of biz ?? []) d[r.key] = r.value;
      setDefaults(d);
    }).catch(() => { if (live) showToast('Could not load branch overrides'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [branchId]);

  async function save(key: string, value: string | null) {
    try {
      await api.post(`/api/branches/${branchId}/settings`, { key, value });
      setOverrides(prev => {
        const next = { ...prev };
        if (value === null) delete next[key]; else next[key] = value;
        return next;
      });
      showToast(value === null ? 'Reverted to business default' : 'Saved');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save');
    }
  }

  if (loading) return <div className="text-gray-500 text-sm">Loading…</div>;

  const contOverridden = 'continuous_operation' in overrides;
  const contDefaultOn  = defaults.continuous_operation === 'true';
  const contValueOn    = contOverridden ? overrides.continuous_operation === 'true' : contDefaultOn;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      {toast && (
        <div className="fixed bottom-6 right-6 bg-green-500 text-white px-5 py-2.5 rounded-lg font-semibold z-50 shadow-lg">{toast}</div>
      )}
      <div>
        <h2 className="text-white font-semibold">Receipt &amp; hours for this branch</h2>
        <p className="text-gray-500 text-xs mt-0.5">Overrides the business-wide defaults for this branch only. Leave inheriting to follow the business setting.</p>
      </div>

      {TEXT_FIELDS.map(f => {
        const overridden = f.key in overrides;
        return (
          <div key={f.key} className="border-t border-gray-800 pt-4 first:border-t-0 first:pt-0">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{f.label}</label>
              <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox" checked={overridden}
                  onChange={e => e.target.checked ? save(f.key, defaults[f.key] ?? '') : save(f.key, null)}
                />
                Override for this branch
              </label>
            </div>
            {overridden ? (
              <textarea
                rows={3}
                value={overrides[f.key] ?? ''}
                onChange={e => setOverrides(prev => ({ ...prev, [f.key]: e.target.value }))}
                onBlur={e => save(f.key, e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3.5 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500 resize-y"
              />
            ) : (
              <div className="text-sm text-gray-500 bg-gray-950/60 border border-gray-800/60 rounded-lg px-3.5 py-2.5 whitespace-pre-wrap min-h-[2.5rem]">
                {defaults[f.key]?.trim() ? defaults[f.key] : <span className="italic text-gray-600">Using business default (empty)</span>}
              </div>
            )}
          </div>
        );
      })}

      <div className="border-t border-gray-800 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">24-hour operation</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {contOverridden ? 'Overridden for this branch' : `Using business default (${contDefaultOn ? 'On' : 'Off'})`}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {contOverridden && (
              <button
                onClick={() => save('continuous_operation', contValueOn ? 'false' : 'true')}
                className={`w-11 h-6 rounded-full transition-colors relative ${contValueOn ? 'bg-green-500' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${contValueOn ? 'left-5' : 'left-0.5'}`} />
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox" checked={contOverridden}
                onChange={e => e.target.checked ? save('continuous_operation', contDefaultOn ? 'true' : 'false') : save('continuous_operation', null)}
              />
              Override
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
