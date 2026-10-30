/**
 * CustomerAskForm.tsx — A607: the form the CUSTOMER fills in — "Add your details" (phone, name, and the KRA PIN when eTIMS
 * is on) or just their M-Pesa number — large and simple, with its own on-screen keyboard. One drawing for both places it
 * appears: the customer screen (A606's second screen, when it is a touch screen — premium) and "Customer types it" on the
 * cashier's own screen turned to the customer (standard). It shows nothing but the form, the bill total, the one consent
 * line and "Save my details for next time" — no menus, no other customers, no staff.
 *
 * What it hands back is only what was typed (id, name, phone, kraPin, save); the caller checks it (customerDetails.ts
 * cleanAnswer — in main on the desktop) and the cashier accepts or corrects it before anything is attached to the sale.
 * Also StkBanner: the M-Pesa prompt's progress as the customer sees it ("Waiting for M-Pesa… (check your phone)").
 *
 * Pure view: no bridge, no fetch. Copies kept identical by scripts/check-shared-sync.mjs: the desktop's renderer
 * (src/shared/) and the web dashboard (src/lib/), each beside its customerDetails.ts.
 */
import { useState, type CSSProperties } from 'react';
import { CONSENT_LINE, SAVE_LABEL, stkWords, type AskRequest, type StkView } from './customerDetails';

export interface AskValues { id: string; name: string; phone: string; kraPin: string; save: boolean }
type Field = 'phone' | 'name' | 'kraPin';

export interface CustomerAskFormProps {
  ask: AskRequest;
  /** Errors by field (shown under it), or null when the answer was taken. */
  onSubmit: (v: AskValues) => Promise<Record<string, string> | null> | Record<string, string> | null;
  onSkip: () => void;
  /** "Skip" on the customer screen; "Back to the cashier" on the cashier's screen. */
  skipLabel?: string;
  /** The customer screen takes no keyboard: typing is by the on-screen keys only (the fields are read-only). */
  keysOnly?: boolean;
  /** For a page that already has its own full-screen backdrop. */
  style?: CSSProperties;
}

const CSS = `
.ca{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#15202b;
  font-family:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,sans-serif;cursor:auto;user-select:none;overflow:auto}
.ca-card{width:min(92vw,1100px);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:3vw;padding:3.4vh 3vw}
.ca-h{font-size:4.2vh;font-weight:700;margin:0 0 .6vh}
.ca-sub{font-size:2.2vh;color:#5e6b78;margin:0 0 2.4vh}
.ca-total{font-size:2.4vh;color:#5e6b78;margin-bottom:2.4vh}.ca-total b{color:#15202b;font-size:3.2vh}
.ca-f{margin-bottom:2vh}
.ca-l{display:block;font-size:2.1vh;color:#3d4752;margin-bottom:.6vh}
.ca-i{width:100%;box-sizing:border-box;font-size:3.4vh;padding:1.4vh 1.4vw;border:2px solid #cfd6dd;border-radius:1.2vh;background:#fff;color:#15202b;outline:none}
.ca-i.on{border-color:#15202b;box-shadow:0 0 0 .4vh #15202b22}
.ca-e{font-size:2vh;color:#b42318;margin-top:.5vh}
.ca-c{display:flex;align-items:center;gap:1vw;font-size:2.3vh;margin:1.4vh 0;cursor:pointer}
.ca-c input{width:3vh;height:3vh}
.ca-p{font-size:1.9vh;color:#5e6b78;line-height:1.4;margin:1vh 0 0}
.ca-b{display:flex;gap:1vw;margin-top:2.4vh}
.ca-btn{flex:1;font-size:2.8vh;font-weight:600;padding:1.8vh 0;border-radius:1.2vh;border:0;cursor:pointer}
.ca-ok{background:#15202b;color:#fff}.ca-ok:disabled{opacity:.5}
.ca-no{background:#e5e9ee;color:#15202b}
.ca-k{display:flex;flex-direction:column;gap:1vh;align-self:center}
.ca-r{display:flex;gap:.8vh;justify-content:center}
.ca-key{min-width:6.4vh;height:7.4vh;font-size:3vh;font-weight:600;border-radius:1vh;border:1px solid #cfd6dd;background:#fff;color:#15202b;cursor:pointer}
.ca-key:active{background:#e5e9ee}
.ca-wide{min-width:24vh}
.ca-stk{position:fixed;inset:0;z-index:61;display:flex;align-items:center;justify-content:center;background:rgba(246,247,249,.94);
  font-family:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,sans-serif;color:#15202b}
.ca-stk-box{text-align:center;padding:5vh 5vw;border-radius:2vh;background:#fff;border:1px solid #e2e6ea;max-width:80vw}
.ca-stk-t{font-size:5vh;font-weight:700;margin:0}
.ca-stk-s{font-size:2.6vh;color:#5e6b78;margin:1.6vh 0 0}
.ca-stk-a{font-size:3.4vh;font-weight:600;margin:2vh 0 0}
.ca-stk.paid .ca-stk-t{color:#15202b}.ca-stk.failed .ca-stk-t{color:#b42318}
`;

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const LETTERS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const money = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function CustomerAskForm({ ask, onSubmit, onSkip, skipLabel = 'Skip', keysOnly = false, style }: CustomerAskFormProps) {
  const mpesa = ask.purpose === 'mpesa';
  const [v, setV] = useState<AskValues>({ id: ask.id, name: '', phone: '', kraPin: '', save: false });
  const [active, setActive] = useState<Field>('phone');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const max: Record<Field, number> = { phone: 16, name: 60, kraPin: 11 };
  const put = (f: Field, s: string) => setV((o) => ({ ...o, [f]: s.slice(0, max[f]) }));
  const key = (k: string) => {
    const cur = v[active];
    if (k === '⌫') put(active, cur.slice(0, -1));
    else if (k === ' ') { if (active === 'name') put(active, cur + ' '); }
    else put(active, cur + (active === 'name' && cur && !/\s$/.test(cur) ? k.toLowerCase() : k));
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try { const e = await onSubmit(v); setErrors(e ?? {}); } finally { setBusy(false); }
  };
  const field = (f: Field, label: string, hint: string) => (
    <div className="ca-f">
      <label className="ca-l" htmlFor={`ca-${f}`}>{label}</label>
      <input id={`ca-${f}`} data-testid={`ca-${f}`} className={`ca-i${active === f ? ' on' : ''}`} value={v[f]} placeholder={hint}
        readOnly={keysOnly} inputMode={keysOnly ? 'none' : f === 'phone' ? 'tel' : 'text'} autoComplete="off" spellCheck={false}
        onFocus={() => setActive(f)} onClick={() => setActive(f)}
        onChange={(e) => put(f, f === 'kraPin' ? e.target.value.toUpperCase() : e.target.value)} />
      {errors[f] && <div className="ca-e" data-testid={`ca-err-${f}`}>{errors[f]}</div>}
    </div>
  );
  const digitsOnly = active === 'phone';
  return (
    <div className="ca" data-testid="customer-ask" style={style}>
      <style>{CSS}</style>
      <div className="ca-card">
        <div>
          <h1 className="ca-h">{mpesa ? 'Your M-Pesa number' : 'Add your details'}</h1>
          <p className="ca-sub">{mpesa ? 'The M-Pesa prompt will be sent to this phone.' : 'Type your details, then press Done.'}</p>
          {ask.amount > 0 && <div className="ca-total" data-testid="ca-total">Total <b>{ask.currency} {money(ask.amount)}</b></div>}
          {field('phone', mpesa ? 'M-Pesa phone number' : 'Phone number', '07XX XXX XXX')}
          {!mpesa && field('name', 'Name', 'Your name')}
          {!mpesa && ask.needPin && field('kraPin', 'KRA PIN (for a tax invoice)', 'A123456789Z')}
          {!mpesa && (
            <label className="ca-c" data-testid="ca-save">
              <input type="checkbox" checked={v.save} onChange={(e) => setV((o) => ({ ...o, save: e.target.checked }))} />
              {SAVE_LABEL}
            </label>
          )}
          {errors.save && <div className="ca-e">{errors.save}</div>}
          {errors.form && <div className="ca-e">{errors.form}</div>}
          {!mpesa && <p className="ca-p" data-testid="ca-consent">{CONSENT_LINE}</p>}
          <div className="ca-b">
            <button className="ca-btn ca-no" onClick={onSkip} data-testid="ca-skip">{skipLabel}</button>
            <button className="ca-btn ca-ok" onClick={submit} disabled={busy} data-testid="ca-done">Done</button>
          </div>
        </div>
        <div className="ca-k" aria-label="Keyboard">
          <div className="ca-r">{DIGITS.slice(0, 5).map((d) => <button key={d} className="ca-key" onClick={() => key(d)}>{d}</button>)}</div>
          <div className="ca-r">{DIGITS.slice(5).map((d) => <button key={d} className="ca-key" onClick={() => key(d)}>{d}</button>)}</div>
          {!digitsOnly && LETTERS.map((row) => (
            <div key={row} className="ca-r">{row.split('').map((c) => <button key={c} className="ca-key" onClick={() => key(c)}>{c}</button>)}</div>
          ))}
          <div className="ca-r">
            {!digitsOnly && active === 'name' && <button className="ca-key ca-wide" onClick={() => key(' ')}>Space</button>}
            <button className="ca-key" onClick={() => key('⌫')} aria-label="Delete">⌫</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The M-Pesa prompt, as the customer sees it: waiting (check your phone), paid, or not completed. Nothing when idle. */
export function StkBanner({ stk }: { stk: StkView }) {
  if (stk.stage === 'idle') return null;
  const w = stkWords(stk.stage);
  return (
    <div className={`ca-stk ${stk.stage}`} data-testid="stk-banner" role="status">
      <style>{CSS}</style>
      <div className="ca-stk-box">
        <p className="ca-stk-t">{w.title}</p>
        <p className="ca-stk-s">{w.sub}</p>
        {stk.amount > 0 && <p className="ca-stk-a">{stk.currency} {money(stk.amount)}</p>}
      </div>
    </div>
  );
}
