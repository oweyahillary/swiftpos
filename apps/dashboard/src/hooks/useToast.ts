/**
 * useToast — lightweight toast hook.
 *
 * No external dependency. Returns a `toast` state object and a `showToast`
 * dispatcher. Renders via the <Toast /> component (see below).
 * Auto-dismisses after `duration` ms (default 4000).
 *
 * Usage:
 *   const { toast, showToast } = useToast();
 *   showToast('Saved', 'success');
 *   showToast('Delete failed', 'error');
 *   <Toast toast={toast} />
 */

import { useState, useCallback, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastState {
  message: string;
  type: ToastType;
  visible: boolean;
}

const DEFAULT: ToastState = { message: '', type: 'info', visible: false };

export function useToast(duration = 4000) {
  const [toast, setToast] = useState<ToastState>(DEFAULT);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type, visible: true });
    timerRef.current = setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, duration);
  }, [duration]);

  const hideToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(prev => ({ ...prev, visible: false }));
  }, []);

  return { toast, showToast, hideToast };
}
