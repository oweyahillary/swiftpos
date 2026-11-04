/**
 * KitchenTicketSettings — what goes on the kitchen ticket: the items kept off it and the quick notes a cashier taps.
 *
 * A620 (owner, 2026-11-01: "under restaurant setup there is a section of keep off kitchen receipt and Quick notes for
 * orders i think it should be under printers not there"): moved, as they were, from Restaurant setup to Settings ›
 * Devices and printers › Printers. Same settings (business_settings kitchen_exclusions, order_note_picks — A367), same
 * saving on blur, same reach (each POS at its next catalogue sync). Shown where Restaurant setup was: a business with tables.
 */
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { parseNotePicks, PICKS_MAX } from '@zaptill/core/orderNotes';

interface BizSetting { key: string; value: string }

const BOX = 'w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono leading-relaxed focus:outline-none focus:border-gray-500';

/** The kitchen list as the box shows it: stored as a JSON array, one name per line here (an old plain value as it is). */
function exclusionsText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.join('\n') : raw;
  } catch { return raw; }
}

export default function KitchenTicketSettings() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    api.get<BizSetting[]>('/api/business/settings')
      .then((rows) => { if (live) setSettings(Object.fromEntries((rows ?? []).map((s) => [s.key, s.value]))); })
      .catch((e) => { if (live) { setSettings({}); setMsg(e instanceof Error ? e.message : 'Could not load'); } });
    return () => { live = false; };
  }, []);

  async function saveSetting(key: string, value: string) {
    try {
      await api.post('/api/business/settings', { key, value });
      setSettings((prev) => ({ ...(prev ?? {}), [key]: value }));
      setMsg('Saved');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  }

  if (!settings) return null;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-8" data-testid="kitchen-ticket-settings">
      {/* ── KITCHEN EXCLUSIONS ────────────────────────────────────────── */}
      <div>
        <h2 className="text-base font-bold text-white mb-1">Keep off the kitchen ticket</h2>
        <p className="text-sm text-gray-500 mb-1">
          One name per line. Anything matching is left off kitchen tickets and
          still printed for the packer — drinks, sauces, packaged sides.
        </p>
        <p className="text-xs text-gray-600 mb-4 italic">
          Matched on whole words, so “soda” catches “Soda 1.25L” and “1L soda”
          without catching “Sodalite”. Applies inside combos too.
        </p>
        <textarea
          rows={7}
          defaultValue={exclusionsText(settings['kitchen_exclusions'] ?? '')}
          placeholder={'soda\nsoft drink\njuice\nsauce\ncole slaw'}
          onBlur={e => {
            // Stored as a JSON array so the POS never has to guess at a separator. Saved on blur — a list somebody types.
            const list = e.target.value.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
            void saveSetting('kitchen_exclusions', JSON.stringify(list));
          }}
          className={BOX}
        />
        <p className="text-xs text-gray-600 mt-2">Takes effect on each POS at its next catalogue sync.</p>
      </div>

      {/* ── A367: QUICK PICKS FOR ORDER NOTES ─────────────────────────── */}
      <div className="pt-6 border-t border-gray-800">
        <h2 className="text-base font-bold text-white mb-1">Quick notes for orders</h2>
        <p className="text-sm text-gray-500 mb-1">
          One per line. The cashier taps these when adding a note to an item — “No salt”, “Extra cheese”, “Spicy”.
          They can still type anything else.
        </p>
        <p className="text-xs text-gray-600 mb-4 italic">
          A note never changes the price. Anything that costs extra belongs on the product as a modifier.
        </p>
        <textarea
          rows={7}
          data-testid="note-picks-editor"
          defaultValue={parseNotePicks(settings['order_note_picks'] ?? null).join('\n')}
          onBlur={e => {
            // Stored as a JSON array, like the kitchen list. An emptied box saves [] — no quick picks at all.
            const list = parseNotePicks(JSON.stringify(e.target.value.split(/\r?\n/)));
            void saveSetting('order_note_picks', JSON.stringify(list));
          }}
          className={BOX}
        />
        <p className="text-xs text-gray-600 mt-2">
          Up to {PICKS_MAX}. Reaches the web POS the next time it opens, and each desktop POS at its next catalogue sync.
        </p>
      </div>
      {msg && <p className="text-xs text-gray-400">{msg}</p>}
    </div>
  );
}
