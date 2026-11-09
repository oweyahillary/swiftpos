import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { ONSCREEN_KEYBOARD_WORDS, DEFAULT_ONSCREEN_KEYBOARD, type OnscreenKeyboard } from '@zaptill/core/onscreenKeyboard';

// Owner, 2026-11-09 ("the in app keyboard can we have it as the menu category it can be turned on or off"): Manager ›
// Settings › On-screen keyboard. The same branch-setting pattern as the category layout (8n) — saved on the cloud for the
// branch (it needs a connection); this POS switches at once, the branch's other POS on their next reload. Desktop only:
// ZapTill's own keyboard (A417). Off is for a POS with a physical keyboard. The words are @zaptill/core/onscreenKeyboard.
export default function OnscreenKeyboardPanel({ canEdit }: { canEdit: boolean }) {
  const [value, setValue] = useState<OnscreenKeyboard>(DEFAULT_ONSCREEN_KEYBOARD);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    posApi.pos.onscreenKeyboard().then((r) => { if (r?.value) setValue(r.value); }).catch(() => {});
  }, []);

  const toggle = async () => {
    if (!canEdit || busy) return;
    const next: OnscreenKeyboard = value === 'on' ? 'off' : 'on';
    const before = value;
    setValue(next); setBusy(true); setError(''); setSaved(false);
    try {
      await posApi.manage.setOnscreenKeyboard(next);
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setValue(before);   // roll back the optimistic flip
      setError(e?.message ?? 'Could not save — this change needs a connection.');
    } finally { setBusy(false); }
  };

  const on = value === 'on';
  return (
    <div className="space-y-2" data-testid="onscreen-keyboard-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="text-white text-sm font-semibold">{ONSCREEN_KEYBOARD_WORDS.title}</h3>
          <p className="text-xs text-gray-400 mt-1">{ONSCREEN_KEYBOARD_WORDS.explain}</p>
          <p className="text-xs text-gray-500 mt-1">{on ? ONSCREEN_KEYBOARD_WORDS.on.hint : ONSCREEN_KEYBOARD_WORDS.off.hint}</p>
        </div>
        <button
          onClick={() => void toggle()}
          disabled={!canEdit || busy}
          role="switch"
          aria-checked={on}
          aria-label={ONSCREEN_KEYBOARD_WORDS.title}
          data-testid="onscreen-keyboard-switch"
          className={`shrink-0 w-12 h-7 rounded-full transition-colors relative disabled:opacity-40 ${on ? 'bg-action-500' : 'bg-gray-700'}`}>
          <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${on ? 'left-6' : 'left-1'}`} />
        </button>
      </div>
      <div className="h-4">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {saved && !error && <span className="text-xs text-gray-300">{ONSCREEN_KEYBOARD_WORDS.saved}</span>}
      </div>
    </div>
  );
}
