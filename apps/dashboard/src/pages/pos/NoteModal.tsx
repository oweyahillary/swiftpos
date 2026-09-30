import { useState } from 'react';
import { cleanNote, hasPick, togglePick, ITEM_NOTE_MAX, ORDER_NOTE_MAX } from '../../lib/orderNotes';

/**
 * NoteModal (web POS) — A367 (0.6.24): a note on one cart line, or on the whole order. The same rules as the till's
 * (shared/orderNotes.ts): free text plus the owner's quick picks; notes are free, they never change the price.
 */
interface Props {
  title: string;
  initial: string | null | undefined;
  picks: string[];
  kind: 'item' | 'order';
  onSave: (note: string | null) => void;
  onClose: () => void;
}

export default function NoteModal({ title, initial, picks, kind, onSave, onClose }: Props) {
  const [text, setText] = useState(initial ?? '');
  const max = kind === 'order' ? ORDER_NOTE_MAX : ITEM_NOTE_MAX;

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.card} onClick={(e) => e.stopPropagation()} data-testid="note-modal">
        <div style={{ fontWeight: 600, color: '#f1f5f9' }}>{kind === 'order' ? 'Note for the order' : 'Note'}</div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>{title}</div>

        {kind === 'item' && picks.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }} data-testid="note-picks">
            {picks.map((p) => {
              const on = hasPick(text, p);
              return (
                <button key={p} type="button" onClick={() => setText((t) => togglePick(t, p))}
                        style={{ ...st.chip, ...(on ? st.chipOn : {}) }}>
                  {p}
                </button>
              );
            })}
          </div>
        )}

        <textarea autoFocus rows={kind === 'order' ? 3 : 4} maxLength={max} value={text}
                  onChange={(e) => setText(e.target.value)} style={st.text}
                  placeholder={kind === 'order' ? 'e.g. Deliver to gate B · Collect at 1pm' : 'e.g. 3 normal, 2 spicy · No salt'} />
        <div style={{ fontSize: 11, color: '#64748b', margin: '6px 0 14px' }}>
          Prints on the kitchen ticket and the receipt. A note never changes the price.
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button style={st.save} onClick={() => onSave(cleanNote(text, max))}>Save note</button>
          {(initial ?? '') !== '' && <button style={st.plain} onClick={() => onSave(null)}>Remove</button>}
          <button style={{ ...st.plain, background: 'transparent', border: 'none' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { background: '#0f172a', border: '1px solid #334155', borderRadius: 14, width: '100%', maxWidth: 440, padding: 18 },
  chip: { padding: '6px 12px', borderRadius: 999, fontSize: 13, border: '1px solid #334155', background: '#1e293b', color: '#e2e8f0', cursor: 'pointer' },
  chipOn: { background: '#0f766e', borderColor: '#14b8a6', color: '#fff' },
  text: { width: '100%', boxSizing: 'border-box', background: '#020617', border: '1px solid #334155', borderRadius: 8, padding: '8px 10px', color: '#f1f5f9', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' },
  save: { flex: 1, background: '#0f766e', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: 'pointer' },
  plain: { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: '10px 14px', cursor: 'pointer' },
};
