/**
 * ExclusionsPanel — the kitchen exclusion editor, extracted from
 * PrinterSetupScreen so it can live as its own tab under the Printers screen
 * (register A83). Behaviour is unchanged (A66): the box shows the EFFECTIVE
 * list — a per-terminal override if set, else the business-wide default synced
 * from the dashboard — and editing sets the override, which wins and survives
 * every sync ("local is final"). "Reset to cloud default" drops the override.
 *
 * Dispatcher exclusions (a second list) are Phase 2 and will slot in here beside
 * the kitchen list.
 */

import { useEffect, useState } from 'react';

export default function ExclusionsPanel() {
  const [liveExclusions, setLiveExclusions] = useState<string>('');
  const [exclSource, setExclSource] = useState<'local' | 'cloud'>('cloud');
  const [cloudExclusions, setCloudExclusions] = useState<string[]>([]);
  const [exclSaved, setExclSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    window.swiftpos.escpos.kitchenExclusions()
      .then(r => {
        if (!alive) return;
        setLiveExclusions((r?.terms ?? []).join('\n'));
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

  // Saved on blur, not per keystroke — a list somebody types, not a toggle. One
  // term per line, so the till never has to guess at a separator. Any save sets
  // the override → source becomes local.
  async function saveExclusions(text: string) {
    const terms = text.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    try {
      const r = await window.swiftpos.escpos.setKitchenExclusions(terms);
      if (r?.ok) {
        setLiveExclusions((r.terms ?? []).join('\n'));
        setExclSource('local');
        flashExclSaved();
      }
    } catch { /* leave the text as typed; nothing was persisted */ }
  }

  async function resetExclusionsToCloud() {
    try {
      const r = await window.swiftpos.escpos.clearKitchenExclusions();
      if (r?.ok) {
        setLiveExclusions((r.terms ?? []).join('\n'));
        setCloudExclusions(r.terms ?? []);
        setExclSource('cloud');
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

      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">Never printed on the kitchen ticket</span>
        <div className="flex items-center gap-2">
          {exclSaved && <span className="text-xs text-emerald-400">Saved</span>}
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            exclSource === 'local' ? 'bg-sky-900/60 text-sky-200' : 'bg-gray-800 text-gray-400'
          }`}>
            {exclSource === 'local' ? 'This terminal' : 'Business default'}
          </span>
        </div>
      </div>

      <textarea
        value={liveExclusions}
        onChange={e => setLiveExclusions(e.target.value)}
        onBlur={e => void saveExclusions(e.target.value)}
        placeholder={'One term per line, e.g.\nsoda\nsoft drink\njuice\nsauce'}
        spellCheck={false}
        className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2
                   text-gray-200 text-sm font-mono h-24 resize-y
                   focus:outline-none focus:border-gray-500"
      />

      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-gray-500">
          {exclSource === 'local' ? (
            <>This terminal&rsquo;s own list, on top of the built-in drinks rule. It overrides the
            business default and is kept through every sync. Saved when you click away.</>
          ) : (
            <>The business default from the web dashboard, on top of the built-in rule. Edit here
            to set a list just for this terminal; saved when you click away.</>
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
