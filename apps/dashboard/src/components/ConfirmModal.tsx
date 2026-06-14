/**
 * ConfirmModal — production-grade confirmation dialog.
 *
 * Replaces all window.confirm() calls and inline ad-hoc modals.
 * Three intents with distinct colour coding:
 *
 *   destructive — red    — permanent deletions, irreversible actions
 *   warning     — amber  — deactivations, consequential but recoverable
 *   neutral     — gray   — low-stakes confirmations
 *
 * Usage:
 *   const [confirm, setConfirm] = useConfirm();
 *
 *   // Trigger:
 *   setConfirm({
 *     title: 'Delete product?',
 *     message: 'This cannot be undone.',
 *     intent: 'destructive',
 *     confirmLabel: 'Delete',
 *     onConfirm: () => deleteProduct(id),
 *   });
 *
 *   // In JSX:
 *   <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
 */

import { useState, useCallback } from 'react';

export type ConfirmIntent = 'destructive' | 'warning' | 'neutral';

export interface ConfirmState {
  title:        string;
  message:      string;
  intent?:      ConfirmIntent;
  confirmLabel?: string;
  cancelLabel?:  string;
  onConfirm:    () => void | Promise<void>;
}

// ── Style maps ────────────────────────────────────────────────────────────────

const BORDER: Record<ConfirmIntent, string> = {
  destructive: 'border-red-500/40',
  warning:     'border-amber-500/40',
  neutral:     'border-gray-700',
};

const ICON_BG: Record<ConfirmIntent, string> = {
  destructive: 'bg-red-500/15 text-red-400',
  warning:     'bg-amber-500/15 text-amber-400',
  neutral:     'bg-gray-800 text-gray-400',
};

const CONFIRM_BTN: Record<ConfirmIntent, string> = {
  destructive: 'bg-red-600 hover:bg-red-500 text-white',
  warning:     'bg-amber-500 hover:bg-amber-400 text-gray-950',
  neutral:     'bg-white hover:bg-gray-100 text-gray-900',
};

const ICON: Record<ConfirmIntent, string> = {
  destructive: '⚠',
  warning:     '⚠',
  neutral:     '?',
};

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  state:   ConfirmState | null;
  onClose: () => void;
}

export default function ConfirmModal({ state, onClose }: Props) {
  const [busy, setBusy] = useState(false);

  if (!state) return null;

  const intent       = state.intent       ?? 'neutral';
  const confirmLabel = state.confirmLabel ?? 'Confirm';
  const cancelLabel  = state.cancelLabel  ?? 'Cancel';

  async function handleConfirm() {
    setBusy(true);
    try {
      await state.onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`bg-gray-900 border ${BORDER[intent]} rounded-2xl w-full max-w-sm shadow-2xl p-6 space-y-4`}>

        {/* Icon + title */}
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-lg font-bold ${ICON_BG[intent]}`}>
            {ICON[intent]}
          </div>
          <div className="min-w-0 pt-1">
            <h2 id="confirm-title" className="text-white font-semibold text-base leading-tight">
              {state.title}
            </h2>
          </div>
        </div>

        {/* Message */}
        <p className="text-gray-400 text-sm leading-relaxed pl-14">
          {state.message}
        </p>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-1">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-gray-400 hover:text-white text-sm font-medium transition-colors disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className={`px-5 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${CONFIRM_BTN[intent]}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useConfirm — pair with ConfirmModal for clean imperative confirm flow.
 *
 * const [confirmState, confirm, closeConfirm] = useConfirm();
 *
 * confirm({
 *   title: 'Delete product?',
 *   message: 'This cannot be undone.',
 *   intent: 'destructive',
 *   confirmLabel: 'Delete',
 *   onConfirm: () => deleteProduct(id),
 * });
 *
 * <ConfirmModal state={confirmState} onClose={closeConfirm} />
 */
export function useConfirm(): [
  ConfirmState | null,
  (state: ConfirmState) => void,
  () => void,
] {
  const [state, setState] = useState<ConfirmState | null>(null);
  const confirm  = useCallback((s: ConfirmState) => setState(s), []);
  const onClose  = useCallback(() => setState(null), []);
  return [state, confirm, onClose];
}
