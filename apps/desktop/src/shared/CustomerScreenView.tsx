/**
 * CustomerScreenView.tsx — A606: what the customer sees on the second screen, drawn from ONE cleaned state
 * (customerScreen.ts DisplayState) and the content the premium gate let through (gateDisplayContent).
 *
 * Read from a metre away: the total is the one big thing, in a solid panel on the right — the cashier's colour when the
 * business has its brand colours (A597 / A605: the primary's light-mode tokens from themes.ts brandPalette, the same
 * engine as the POS), otherwise a calm ZapTill ink. Light by default (it faces the customer, often in daylight); nothing
 * flashes; the slideshow cross-fades slowly and not at all for "reduce motion". The words follow the business type
 * (displayWords). "POS", never "till" — the M-Pesa "Till number" is Safaricom's own name for it.
 *
 * Pure view: no bridge, no fetch. Copies kept identical by scripts/check-shared-sync.mjs: the desktop's renderer
 * (src/shared/) and the web dashboard (src/lib/), each beside its customerScreen.ts and themes.ts.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { displayWords, lineQuantityText, shownStage, THANKS_MS, type DisplayState, type DisplayContent } from './customerScreen';
import { brandPalette, resolveTheme, labelOn } from '@zaptill/core/themes';

export interface ScreenPalette { panel: string; onPanel: string; mark: string; markSoft: string }

const NEUTRAL: ScreenPalette = { panel: '#15202b', onPanel: '#ffffff', mark: '#3d4752', markSoft: '#eff1f4' };

/** The colours the customer screen wears: the brand (themes on) or the neutral ZapTill look. */
export function screenPalette(brand: DisplayContent['brand']): ScreenPalette {
  if (!brand) return NEUTRAL;
  const p = brandPalette(brand.primaryHex);
  if (p) {
    const s = brandPalette(brand.secondaryHex);
    return { panel: p.light.primary, onPanel: p.light.onPrimary, mark: s ? s.light.text : p.light.text, markSoft: p.light.subtle };
  }
  const t = resolveTheme(brand.themeId).shades as unknown as Record<string, string>;
  const panel = t['700'] ?? NEUTRAL.panel;
  return { panel, onPanel: labelOn(panel as `#${string}`), mark: t['700'] ?? NEUTRAL.mark, markSoft: t['50'] ?? NEUTRAL.markSoft };
}

const money = (n: number) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 123456 → "123 456", 4098201 → "4 098 201": read out and keyed in groups of three. */
export const groupDigits = (d: string) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const CSS = `
.cs{position:fixed;inset:0;display:flex;flex-direction:column;background:#f6f7f9;color:#15202b;overflow:hidden;
  font-family:"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;cursor:none;user-select:none}
.cs-top{display:flex;align-items:center;gap:1.4vh;padding:2.6vh 3.2vw 1.8vh}
.cs-logo{height:6.4vh;max-width:18vw;object-fit:contain}
.cs-name{font-size:3.1vh;font-weight:600;letter-spacing:-.01em}
.cs-table{margin-left:auto;font-size:2.6vh;color:#5e6b78}
.cs-body{flex:1;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:2.4vw;padding:0 3.2vw 3.2vh;min-height:0}
.cs-list{display:flex;flex-direction:column;min-height:0;background:#fff;border:1px solid #e2e6ea;border-radius:1.6vh}
.cs-h{font-size:2.3vh;color:#5e6b78;padding:2.2vh 2.4vw 1.2vh;border-bottom:1px solid #e2e6ea}
.cs-lines{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.cs-line{display:grid;grid-template-columns:1fr auto;column-gap:2vw;padding:1.5vh 2.4vw;border-top:1px solid #eef0f3}
.cs-line:first-child{border-top:0}
.cs-line.last{box-shadow:inset .45vw 0 0 var(--mark);background:var(--mark-soft)}
.cs-ln{font-size:3vh;font-weight:600;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cs-lt{font-size:3vh;font-weight:600;text-align:right}
.cs-lq{font-size:2.2vh;color:#5e6b78;margin-top:.3vh}
.cs-ld{font-size:2.1vh;color:#5e6b78;text-align:right;margin-top:.3vh}
.cs-off{color:var(--mark)}
.cs-empty{flex:1;display:flex;align-items:center;justify-content:center;font-size:2.6vh;color:#8a96a3}
.cs-side{display:flex;flex-direction:column;gap:2vh;min-height:0}
.cs-sums{background:#fff;border:1px solid #e2e6ea;border-radius:1.6vh;padding:2vh 2vw;font-size:2.5vh}
.cs-row{display:flex;justify-content:space-between;gap:1vw;padding:.5vh 0;color:#3c4854}
.cs-total{flex:1;display:flex;flex-direction:column;justify-content:flex-end;border-radius:1.6vh;padding:3vh 2.2vw;
  background:var(--panel);color:var(--on-panel);min-height:0}
.cs-tl{font-size:2.6vh;opacity:.85}
.cs-cur{font-size:3vh;font-weight:600;opacity:.85;margin-top:1vh}
.cs-big{font-size:min(11vh,8.4vw);font-weight:700;line-height:1;letter-spacing:-.02em;white-space:nowrap}
.cs-pay{display:grid;grid-template-columns:1fr 1fr;gap:1.4vh 1vw;margin-top:2.4vh;padding-top:2vh;border-top:1px solid currentColor;
  border-color:color-mix(in srgb,currentColor 30%,transparent);font-size:2.4vh}
.cs-pay b{display:block;font-size:4.6vh;font-weight:700;line-height:1.1}
.cs-mp{background:#fff;border:1px solid #e2e6ea;border-radius:1.6vh;padding:3vh 2.4vw;display:flex;flex-direction:column;gap:1.2vh;flex:1}
.cs-mpt{font-size:3vh;font-weight:600}
.cs-mpk{font-size:2.3vh;color:#5e6b78;margin-top:1.4vh}
.cs-mpn{font-size:min(9vh,6.4vw);font-weight:700;letter-spacing:.04em;line-height:1.05}
.cs-mid{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:2.2vh;padding:4vh 6vw}
.cs-hero{font-size:7vh;font-weight:700;letter-spacing:-.02em;line-height:1.1;max-width:80vw}
.cs-sub{font-size:3vh;color:#5e6b78}
.cs-chg{margin-top:2vh;padding:2.4vh 3vw;border-radius:1.6vh;background:var(--panel);color:var(--on-panel);font-size:3vh}
.cs-chg b{display:block;font-size:8vh;font-weight:700;line-height:1.05}
.cs-mid .cs-logo{height:16vh;max-width:40vw}
.cs-slides{position:absolute;inset:0;background:#0f1720}
.cs-slide{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity 1.2s ease}
.cs-slide.on{opacity:1}
.cs-band{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:1.4vh;padding:1.6vh 3vw;
  background:rgba(255,255,255,.92);color:#15202b}
.cs-band .cs-logo{height:5vh}
@media (prefers-reduced-motion:reduce){.cs-slide{transition:none}}
`;

export interface CustomerScreenViewProps {
  state: DisplayState;
  content: DisplayContent;
  /** The slideshow images ready to show (data or https URLs), in the owner's order. Empty: no slideshow. */
  slides: string[];
  /** For tests: the clock. */
  now?: number;
}

export default function CustomerScreenView({ state, content, slides, now }: CustomerScreenViewProps) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  // "Thank you" leaves on its own after THANKS_MS — one timer for that moment, no ticking.
  useEffect(() => {
    if (now !== undefined) { setClock(now); return; }
    setClock(Date.now());
    if (state.stage !== 'thanks' || !state.since) return;
    const t = setTimeout(() => setClock(Date.now()), Math.max(0, state.since + THANKS_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [state.stage, state.since, now]);
  const stage = shownStage(state, clock);
  const words = displayWords(state.mode);
  const pal = useMemo(() => screenPalette(content.brand), [content.brand]);
  const vars = { '--panel': pal.panel, '--on-panel': pal.onPanel, '--mark': pal.mark, '--mark-soft': pal.markSoft } as CSSProperties;
  const logo = content.brand?.logo ?? null;
  const name = content.businessName;
  const cur = state.currency;

  // The slideshow: one image at a time, `seconds` each, only while idle.
  const [slide, setSlide] = useState(0);
  const count = stage === 'idle' ? slides.length : 0;
  const seconds = Math.max(3, content.seconds || 8);
  useEffect(() => {
    if (count < 2) return;
    const t = setInterval(() => setSlide((i) => (i + 1) % count), seconds * 1000);
    return () => clearInterval(t);
  }, [count, seconds]);

  if (stage === 'idle') {
    return (
      <div className="cs" style={vars} data-testid="cs-idle">
        <style>{CSS}</style>
        {count > 0 ? (
          <div className="cs-slides" data-testid="cs-slides">
            {slides.map((src, i) => <img key={i} src={src} alt="" className={`cs-slide${i === slide % count ? ' on' : ''}`} />)}
            <div className="cs-band">
              {logo && <img className="cs-logo" src={logo} alt="" />}
              <span className="cs-name">{name}</span>
            </div>
          </div>
        ) : (
          <div className="cs-mid">
            {logo && <img className="cs-logo" src={logo} alt="" data-testid="cs-logo" />}
            <div className="cs-hero" data-testid="cs-name">{name}</div>
            <div className="cs-sub">{words.welcome}</div>
          </div>
        )}
      </div>
    );
  }

  if (stage === 'thanks') {
    return (
      <div className="cs" style={vars} data-testid="cs-thanks">
        <style>{CSS}</style>
        <div className="cs-mid">
          {logo && <img className="cs-logo" src={logo} alt="" />}
          <div className="cs-hero">{words.thanks}</div>
          <div className="cs-sub">Paid {cur} {money(state.amountDue || state.total)}</div>
          {state.change > 0 && <div className="cs-chg" data-testid="cs-change">Your change<b>{cur} {money(state.change)}</b></div>}
        </div>
      </div>
    );
  }

  const paying = stage === 'payment';
  const due = paying ? (state.amountDue || state.total) : state.total;
  const mpesa = paying && state.method === 'mpesa' ? content.mpesa : null;
  return (
    <div className="cs" style={vars} data-testid={`cs-${stage}`}>
      <style>{CSS}</style>
      <div className="cs-top">
        {logo && <img className="cs-logo" src={logo} alt="" data-testid="cs-logo" />}
        <span className="cs-name">{name}</span>
        {state.table && <span className="cs-table" data-testid="cs-table">Table {state.table}</span>}
      </div>
      <div className="cs-body">
        {mpesa ? (
          <div className="cs-mp" data-testid="cs-mpesa">
            <div className="cs-mpt">Pay with M-Pesa</div>
            <div className="cs-sub">{mpesa.kind === 'paybill' ? 'Lipa na M-Pesa › Pay Bill' : 'Lipa na M-Pesa › Buy Goods and Services'}</div>
            <div className="cs-mpk">{mpesa.kind === 'paybill' ? 'Business number' : 'Buy Goods till number'}</div>
            <div className="cs-mpn">{groupDigits(mpesa.number)}</div>
            {mpesa.kind === 'paybill' && mpesa.account && (<>
              <div className="cs-mpk">Account number</div>
              <div className="cs-mpn">{mpesa.account}</div>
            </>)}
            <div className="cs-mpk">Amount {cur} {money(due)}</div>
          </div>
        ) : (
          <div className="cs-list">
            <div className="cs-h">{words.heading}</div>
            {state.lines.length === 0 ? <div className="cs-empty">{words.empty}</div> : (
              <div className="cs-lines">
                {state.lines.map((l, i) => (
                  <div key={i} className={`cs-line${i === state.lines.length - 1 ? ' last' : ''}`} data-testid="cs-line">
                    <div className="cs-ln">{l.name}</div>
                    <div className="cs-lt">{money(l.lineTotal)}</div>
                    <div className="cs-lq">{lineQuantityText(l)}{l.detail ? ` · ${l.detail}` : ''}</div>
                    <div className="cs-ld">{l.discount > 0 && <span className="cs-off">Offer −{money(l.discount)}</span>}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="cs-side">
          {(state.discount > 0 || state.subtotal !== state.total) && (
            <div className="cs-sums" data-testid="cs-sums">
              <div className="cs-row"><span>Subtotal</span><span>{money(state.subtotal)}</span></div>
              {state.discount > 0 && <div className="cs-row cs-off" data-testid="cs-discount"><span>Discount</span><span>−{money(state.discount)}</span></div>}
            </div>
          )}
          <div className="cs-total" data-testid="cs-total">
            <div className="cs-tl">{paying ? 'To pay' : 'Total'}</div>
            <div className="cs-cur">{cur}</div>
            <div className="cs-big">{money(due)}</div>
            {paying && state.method === 'cash' && state.paid > 0 && (
              <div className="cs-pay" data-testid="cs-cash">
                <div>Given<b>{money(state.paid)}</b></div>
                <div>Change<b data-testid="cs-change">{money(state.change)}</b></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
