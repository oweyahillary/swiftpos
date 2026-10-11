/**
 * OnScreenKeyboard — A417 part 2 (owner, 2026-10-09: "when a cashier taps on a text box … make the keypad appear
 * something like the image attached without covering the text box where a value is being keyed in"; "all tills").
 *
 * Mounted once at the root of the till. A field TAPPED with a finger or pen opens it (a mouse click or a physical
 * keyboard does not — a till with a real keyboard is not bothered). It docks at the bottom of the screen, or at the top
 * when the field is low, so the field being typed in always shows (lib/osk.ts oskDock). While it is open the field asks
 * Windows for no keyboard of its own (inputmode="none"), and gets its old setting back when it closes. Keys write through
 * the field's own value setter and an `input` event, so React's onChange sees them as typing.
 */
import { useEffect, useRef, useState } from 'react';
import { oskServes, oskLayout, oskDock, oskHeight, oskApply, TEXT_ROWS, SYMBOL_ROW, NUMERIC_ROWS, type OskKey, type OskLayout } from '../lib/osk';

type Field = HTMLInputElement | HTMLTextAreaElement;

function setNativeValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function selection(el: Field): { start: number | null; end: number | null } {
  try { return { start: el.selectionStart, end: el.selectionEnd }; } catch { return { start: null, end: null }; }   // number inputs
}

export default function OnScreenKeyboard() {
  const [field, setField] = useState<Field | null>(null);
  const [layout, setLayout] = useState<OskLayout>('text');
  const [dock, setDock] = useState<'bottom' | 'top'>('bottom');
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const lastPointer = useRef<string>('mouse');
  const savedMode = useRef<string | null>(null);
  const height = oskHeight(typeof window === 'undefined' ? 800 : window.innerHeight);

  // How the last press was made: a finger or pen opens the keyboard, a mouse does not.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => { lastPointer.current = e.pointerType || 'mouse'; };
    window.addEventListener('pointerdown', onPointer, true);
    return () => window.removeEventListener('pointerdown', onPointer, true);
  }, []);

  useEffect(() => {
    const open = (el: Field) => {
      const rect = el.getBoundingClientRect();
      setLayout(oskLayout(el));
      setDock(oskDock(rect, window.innerHeight, height));
      setShift(false); setSymbols(false);
      // Windows' own keyboard stays shut while ours is up (restored on close).
      savedMode.current = el.getAttribute('inputmode');
      el.setAttribute('data-osk-mode', savedMode.current ?? '');
      el.setAttribute('inputmode', 'none');
      setField(el);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Field | null;
      if (!el || !('tagName' in el)) return;
      if (lastPointer.current !== 'touch' && lastPointer.current !== 'pen') return;
      if (!oskServes(el)) return;
      open(el);
    };
    const onFocusOut = (e: FocusEvent) => {
      const el = e.target as Field | null;
      // A tap on the keyboard keeps the field (its keys never take focus); anything else closes it.
      const to = e.relatedTarget as HTMLElement | null;
      if (to && to.closest('[data-osk-root]')) return;
      if (el && el === fieldRef.current) close();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => { document.removeEventListener('focusin', onFocusIn); document.removeEventListener('focusout', onFocusOut); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  const fieldRef = useRef<Field | null>(null);
  fieldRef.current = field;

  function close() {
    const el = fieldRef.current;
    if (el) {
      const was = el.getAttribute('data-osk-mode');
      if (was) el.setAttribute('inputmode', was); else el.removeAttribute('inputmode');
      el.removeAttribute('data-osk-mode');
    }
    setField(null);
  }

  const press = (key: OskKey) => {
    const el = fieldRef.current;
    if (!el || !el.isConnected) { close(); return; }
    const { start, end } = selection(el);
    const next = oskApply(el.value, start, end, key);
    setNativeValue(el, next.value);
    try { el.setSelectionRange(next.caret, next.caret); } catch { /* number inputs */ }
    if (shift && key.kind === 'char') setShift(false);
  };

  const enter = () => {
    const el = fieldRef.current;
    if (!el) return;
    if (el instanceof HTMLTextAreaElement) { press({ kind: 'char', ch: '\n' }); return; }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    el.form?.requestSubmit?.();
    close();
  };

  if (!field) return null;

  // Keys never take focus — the field keeps its caret.
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();
  const keyCls = 'rounded-lg bg-white text-gray-900 text-lg font-medium shadow-sm active:bg-gray-200 select-none flex items-center justify-center';
  const wideCls = 'rounded-lg bg-gray-200 text-gray-800 text-sm font-semibold shadow-sm active:bg-gray-300 select-none flex items-center justify-center';
  const K = ({ label, onPress, cls = keyCls, grow = 1, testid }: { label: React.ReactNode; onPress: () => void; cls?: string; grow?: number; testid?: string }) => (
    <button type="button" tabIndex={-1} data-testid={testid} onPointerDown={keep} onMouseDown={keep} onClick={onPress}
      className={cls} style={{ flex: grow, minWidth: 0 }}>{label}</button>
  );
  const ch = (c: string) => (shift ? c.toUpperCase() : c);

  return (
    <div data-osk-root data-testid="on-screen-keyboard" onPointerDown={keep} onMouseDown={keep}
      className={`fixed left-0 right-0 z-[100] bg-gray-300/95 border-gray-400 shadow-2xl px-2 py-2 ${dock === 'bottom' ? 'bottom-0 border-t' : 'top-0 border-b'}`}
      style={{ height }}>
      <div className="mx-auto h-full flex flex-col gap-1.5" style={{ maxWidth: layout === 'numeric' ? 420 : 980 }}>
        {layout === 'numeric' ? (
          <>
            {NUMERIC_ROWS.map((row, i) => (
              <div key={i} className="flex gap-1.5 flex-1">
                {row.map(c => <K key={c} label={c} onPress={() => press({ kind: 'char', ch: c })} />)}
              </div>
            ))}
            <div className="flex gap-1.5 flex-1">
              <K label="Clear" cls={wideCls} onPress={() => press({ kind: 'clear' })} />
              <K label="⌫" cls={wideCls} testid="osk-backspace" onPress={() => press({ kind: 'backspace' })} />
              <K label="Done" cls={wideCls + ' !bg-action-500 !text-gray-950'} testid="osk-done" onPress={enter} />
            </div>
          </>
        ) : (
          <>
            {(symbols ? [SYMBOL_ROW, ...TEXT_ROWS.slice(1)] : TEXT_ROWS).map((row, i) => (
              <div key={i} className="flex gap-1.5 flex-1">
                {i === 3 && <K label="⇧" cls={wideCls + (shift ? ' !bg-gray-400' : '')} onPress={() => setShift(s => !s)} grow={1.4} />}
                {row.map(c => <K key={c} label={ch(c)} onPress={() => press({ kind: 'char', ch: ch(c) })} />)}
                {i === 0 && <K label="⌫" cls={wideCls} testid="osk-backspace" onPress={() => press({ kind: 'backspace' })} grow={1.6} />}
              </div>
            ))}
            <div className="flex gap-1.5 flex-1">
              <K label={symbols ? 'abc' : '&123'} cls={wideCls} onPress={() => setSymbols(s => !s)} grow={1.4} />
              <K label="space" cls={keyCls + ' !text-sm text-gray-500'} onPress={() => press({ kind: 'char', ch: ' ' })} grow={6} />
              <K label="Done" cls={wideCls + ' !bg-action-500 !text-gray-950'} testid="osk-done" onPress={enter} grow={1.6} />
              <K label="✕" cls={wideCls} onPress={close} grow={0.9} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
