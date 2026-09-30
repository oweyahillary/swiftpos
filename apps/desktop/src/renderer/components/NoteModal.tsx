import { useState } from 'react';
import { cleanNote, hasPick, togglePick, ITEM_NOTE_MAX, ORDER_NOTE_MAX } from '../../shared/orderNotes';

/**
 * NoteModal — A367 (0.6.24): a note on one cart line, or on the whole order.
 *
 * Owner, 2026-09-30: "a mixture of 3 normal and 2 spicy chicken pieces or they want exta cheese if it pizza or no salt".
 * Free text plus the owner's quick picks (tap to add, tap again to take off). Notes are free — anything priced stays a
 * modifier in Menu. The note prints on the kitchen ticket and the receipt, and reaches the cloud with the sale.
 */
interface Props {
  /** "Chicken Piece ×5" or "the whole order". */
  title: string;
  initial: string | null | undefined;
  picks: string[];
  /** 'item' = one line (quick picks shown); 'order' = the whole order (free text only, a longer limit). */
  kind: 'item' | 'order';
  onSave: (note: string | null) => void;
  onClose: () => void;
}

export default function NoteModal({ title, initial, picks, kind, onSave, onClose }: Props) {
  const [text, setText] = useState(initial ?? '');
  const max = kind === 'order' ? ORDER_NOTE_MAX : ITEM_NOTE_MAX;
  const save = () => onSave(cleanNote(text, max));

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center px-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-5 space-y-4"
           onClick={(e) => e.stopPropagation()} data-testid="note-modal">
        <div>
          <h3 className="text-white font-semibold">{kind === 'order' ? 'Note for the order' : 'Note'}</h3>
          <p className="text-gray-400 text-sm truncate">{title}</p>
        </div>

        {kind === 'item' && picks.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="note-picks">
            {picks.map((p) => {
              const on = hasPick(text, p);
              return (
                <button key={p} type="button" onClick={() => setText((t) => togglePick(t, p))}
                        className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${on
                          ? 'bg-action-700 border-action-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-200 hover:border-gray-500'}`}>
                  {p}
                </button>
              );
            })}
          </div>
        )}

        <textarea
          autoFocus rows={kind === 'order' ? 3 : 4} maxLength={max} value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={kind === 'order' ? 'e.g. Deliver to gate B · Customer will collect at 1pm' : 'e.g. 3 normal, 2 spicy · No salt'}
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-gray-500"
        />
        <p className="text-xs text-gray-500">Prints on the kitchen ticket and the receipt. A note never changes the price.</p>

        <div className="flex gap-2">
          <button onClick={save} className="flex-1 bg-action-700 hover:bg-action-600 text-white font-semibold rounded-lg py-2.5">
            Save note
          </button>
          {(initial ?? '') !== '' && (
            <button onClick={() => onSave(null)} className="px-4 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg py-2.5">
              Remove
            </button>
          )}
          <button onClick={onClose} className="px-4 text-gray-400 hover:text-gray-200">Cancel</button>
        </div>
      </div>
    </div>
  );
}
