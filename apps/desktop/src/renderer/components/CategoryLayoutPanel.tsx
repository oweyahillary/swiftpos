import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { CATEGORY_LAYOUT_WORDS, DEFAULT_CATEGORY_LAYOUT, type CategoryLayout } from '@zaptill/core/categoryLayout';

// 8n — Manager › Settings › Categories on the POS (docs/SHARED-COMPONENTS-PLAN.md 8n).
// Owner, 2026-11-05: "initially we used to have a horizontal navbar for categories then we introduced the current vertical
// one can we have the option for both which can be toggled per branch by the manager? in the desktop app?"
// Two choices for THIS branch: the side panel behind ☰ (the standard) or a bar across the top. Saved on the cloud for the
// branch (it needs a connection); this POS switches at once, the branch's other POS from the change log, the web POS on
// its next load. The words are the web's too (@zaptill/core/categoryLayout).
export default function CategoryLayoutPanel({ canEdit }: { canEdit: boolean }) {
  const [layout, setLayout] = useState<CategoryLayout>(DEFAULT_CATEGORY_LAYOUT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi.pos.categoryLayout().then((r) => { if (r?.layout) setLayout(r.layout); }).catch(() => {});
  }, []);

  const choose = async (next: CategoryLayout) => {
    if (!canEdit || busy || next === layout) return;
    const before = layout;
    setLayout(next); setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setCategoryLayout(next);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setLayout(before);   // roll back the optimistic choice
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="category-layout-panel">
      <div>
        <h3 className="text-white text-sm font-semibold">{CATEGORY_LAYOUT_WORDS.title}</h3>
        <p className="text-xs text-gray-400 mt-1">{CATEGORY_LAYOUT_WORDS.explain}</p>
      </div>
      <div role="radiogroup" aria-label={CATEGORY_LAYOUT_WORDS.title} className="grid gap-2 sm:grid-cols-2">
        {CATEGORY_LAYOUT_WORDS.options.map((o) => {
          const on = layout === o.value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={on} disabled={!canEdit || busy}
              onClick={() => void choose(o.value)} data-testid={`category-layout-${o.value}`}
              className={`min-h-[56px] rounded-xl border px-4 py-2.5 text-left transition-colors disabled:opacity-60 ${
                on ? 'border-action-500 bg-action-500/15 text-white' : 'border-gray-800 text-gray-200 hover:border-gray-600'}`}>
              <span className="block text-sm font-semibold">{o.label}</span>
              <span className="block text-xs text-gray-400 mt-0.5">{o.hint}</span>
            </button>
          );
        })}
      </div>
      <div className="h-4">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && !error && <span className="text-xs text-gray-300">{CATEGORY_LAYOUT_WORDS.saved}</span>}
      </div>
    </div>
  );
}
