/**
 * Toast — inline notification banner.
 *
 * Positioned at the top-centre of the viewport. Auto-dismissed by useToast.
 * Replaces all window.alert() calls across the dashboard.
 *
 * Usage:
 *   import { useToast } from '../hooks/useToast';
 *   import Toast from '../components/Toast';
 *
 *   const { toast, showToast } = useToast();
 *   <Toast toast={toast} />
 */

import type { ToastState } from '../hooks/useToast';

interface Props {
  toast: ToastState;
  onDismiss?: () => void;
}

const STYLES: Record<ToastState['type'], string> = {
  success: 'bg-green-500/15 border-green-500/40 text-green-300',
  error:   'bg-red-500/15   border-red-500/40   text-red-300',
  warning: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
  info:    'bg-blue-500/15  border-blue-500/40  text-blue-300',
};

const ICONS: Record<ToastState['type'], string> = {
  success: '✓',
  error:   '✕',
  warning: '⚠',
  info:    'ℹ',
};

export default function Toast({ toast, onDismiss }: Props) {
  if (!toast.visible) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`
        fixed top-4 left-1/2 -translate-x-1/2 z-[9999]
        flex items-center gap-3 px-4 py-3 rounded-xl border shadow-2xl
        text-sm font-medium max-w-sm w-full mx-4
        animate-in fade-in slide-in-from-top-2 duration-200
        ${STYLES[toast.type]}
      `}
    >
      <span className="flex-shrink-0 text-base font-bold">{ICONS[toast.type]}</span>
      <span className="flex-1 min-w-0">{toast.message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}
