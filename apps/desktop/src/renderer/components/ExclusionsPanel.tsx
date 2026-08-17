/**
 * ExclusionsPanel — the kitchen exclusion editor, extracted from
 * PrinterSetupScreen so it can live as its own tab under the Printers screen
 * (register A83). The box shows the EFFECTIVE list — a per-terminal override if
 * set, else the business-wide default synced from the dashboard — and saving
 * sets the override, which wins and survives every sync ("local is final").
 * "Reset to cloud default" drops the override.
 *
 * A98: terms are edited as chips with an explicit Save button, instead of a
 * free-text box that saved silently on blur — a clearer signal that a change was
 * actually persisted. Add a term with Enter or the Add button (a pasted
 * comma/line-separated list is split automatically); remove one with its ✕.
 *
 * Dispatcher exclusions (a second list) are Phase 2 and will slot in here beside
 * the kitchen list.
 */

import { useEffect, useState } from 'react';
import { KITCHEN_NOTE_EXCLUDE_LABELS } from '../lib/ticketLines';

export default function ExclusionsPanel() {
  const [terms, setTerms] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exclSource, setExclSource] = useState<'local' | 'cloud'>('cloud');
  const [cloudExclusions, setCloudExclusions] = useState<string[]>([]);
  const [exclSaved, setExclSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    window.swiftpos.escpos.kitchenExclusions()
      .then(r => {
        if (!alive) return;
        setTerms(r?.terms ?? []);
        setExclSource(r?.source ?? 'cloud');
        setCloudExclusions(r?.cloudTerms ?? []);
      })
      .catch(() => { /* the built-in rule still applies */ });
    return () => { alive = false; };
  }, []);

  function flashExclSaved() {
    setExclSaved(true);
    setTimeout(() => setExclSaved(false), 1500);
  }

  // Add one or more terms from the draft. A pasted "soda, juice" or multi-line
  // list is split so the till never has to guess at a separator. Case-insensitive
  // de-dupe against what's already there.
  function addFromDraft() {
    const incoming = draft.split(/[\r\n,]+/).map(t => t.trim()).filter(Boolean);
    if (incoming.length === 0) return;
    setTerms(prev => {
      const seen = new Set(prev.map(t => t.toLowerCase()));
      const next = [...prev];
      for (const t of incoming) {
        if (!seen.has(t.toLowerCase())) { next.push(t); seen.add(t.toLowerCase()); }
      }
      return next;
    });
    setDraft('');
    setDirty(true);
  }

  function removeTerm(term: string) {
    setTerms(prev => prev.filter(t => t !== term));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const r = await window.swiftpos.escpos.setKitchenExclusions(terms);
      if (r?.ok) {
        setTerms(r.terms ?? []);
        setExclSource('local');
        setDirty(false);
        flashExclSaved();
      }
    } catch { /* leave the list as edited; nothing was persisted */ }
    finally { setSaving(false); }
  }

  async function resetExclusionsToCloud() {
    try {
      const r = await window.swiftpos.escpos.clearKitchenExclusions();
      if (r?.ok) {
        setTerms(r.terms ?? []);
        setCloudExclusions(r.terms ?? []);
        setExclSource('cloud');
        setDirty(false);
        flashExclSaved();
      }
    } catch { /* leave as is */ }
  }

  return (
    <div className="max-w-md space-y-3">
      <div>
        <h3 className="text-white font-semibold">Kitchen exclusions</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Items whose name matches any of these terms are never printed on the kitchen
          ticket — on top of the built-in drinks rule.
        </p>
      </div>

      {/* Built-in rule, read-only, so the owner sees what's already handled and
          doesn't re-add it. These always apply and can't be turned off here. */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-3">
        <p className="text-xs text-gray-400 mb-2">Always excluded (built in):</p>
        <div className="flex flex-wrap gap-1.5">
          {KITCHEN_NOTE_EXCLUDE_LABELS.map(t => (
            <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700">
              {t}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-gray-600 mt-2">
          Matched as whole words, so &ldquo;water&rdquo; won&rsquo;t catch &ldquo;watermelon&rdquo;. Add your own below.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">Never printed on the kitchen ticket</span>
        <div className="flex items-center gap-2">
          {exclSaved && <span className="text-xs text-emerald-400">Saved</span>}
          {dirty && !exclSaved && <span className="text-xs text-amber-400">Unsaved</span>}
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            exclSource === 'local' ? 'bg-sky-900/60 text-sky-200' : 'bg-gray-800 text-gray-400'
          }`}>
            {exclSource === 'local' ? 'This terminal' : 'Business default'}
          </span>
        </div>
      </div>

      {/* The editable list, as chips. */}
      <div className="rounded-xl border border-gray-700 bg-gray-900 p-2.5 min-h-[3rem]">
        {terms.length === 0 ? (
          <p className="text-xs text-gray-600 px-1 py-1.5">No terms yet — add one below.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {terms.map(t => (
              <span key={t} className="inline-flex items-center gap-1 text-xs pl-2.5 pr-1 py-1 rounded-full bg-sky-900/40 text-sky-100 border border-sky-800">
                {t}
                <button
                  onClick={() => removeTerm(t)}
                  className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-sky-800/80 text-sky-300 hover:text-white"
                  title={`Remove "${t}"`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Add + Save row. */}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addFromDraft(); } }}
          placeholder="Add a term, e.g. soda"
          spellCheck={false}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-gray-500"
        />
        <button
          onClick={addFromDraft}
          disabled={!draft.trim()}
          className="px-3 py-2 rounded-lg text-sm border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40"
        >
          Add
        </button>
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-green-500 hover:bg-green-400 text-gray-950 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-gray-500">
          {exclSource === 'local' ? (
            <>This terminal&rsquo;s own list, on top of the built-in drinks rule. It overrides the
            business default and is kept through every sync.</>
          ) : (
            <>The business default from the web dashboard, on top of the built-in rule. Add terms
            and Save to set a list just for this terminal.</>
          )}
        </p>
        {exclSource === 'local' && (
          <button
            onClick={() => void resetExclusionsToCloud()}
            className="shrink-0 text-xs text-gray-400 underline underline-offset-2 hover:text-gray-200"
            title={cloudExclusions.length ? `Dashboard: ${cloudExclusions.join(', ')}` : 'Dashboard has no exclusions set'}
          >
            Reset to cloud default
          </button>
        )}
      </div>
    </div>
  );
}
