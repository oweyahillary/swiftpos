/**
 * CustomerDisplayWebPage.tsx — A606: the web POS's customer screen (/customer-display), opened by "Open customer screen".
 * It only listens on the BroadcastChannel (lib/customerScreenChannel.ts) — the POS window sends the cleaned state and the
 * content its premium gate let through. The same view as the desktop's customer screen (lib/CustomerScreenView.tsx).
 *
 * A607: "Add your details" / the M-Pesa number when the cashier asks (on a touch screen), checked here and again by the POS
 * window before the cashier sees it; and the M-Pesa prompt's progress. It says 'here' every few seconds.
 */
import { useEffect, useState } from 'react';
import CustomerScreenView from '@zaptill/ui/CustomerScreenView';
import { idleState, sanitiseDisplayState, gateDisplayContent, type DisplayContent, type DisplayState } from '@zaptill/core/customerScreen';
import { openChannel, type ChannelMessage } from '../../lib/customerScreenChannel';
import CustomerAskForm, { StkBanner } from '@zaptill/ui/CustomerAskForm';   // A607
import { sanitiseAsk, sanitiseStk, cleanAnswer, type AskRequest, type StkView } from '@zaptill/core/customerDetails';

const EMPTY: DisplayContent = gateDisplayContent({ businessName: null, themeId: null, logo: null, primaryHex: null, secondaryHex: null,
  accentHex: null, licensed: false, slides: null, mpesa: null });

export default function CustomerDisplayWebPage() {
  const [state, setState] = useState<DisplayState>(() => idleState());
  const [content, setContent] = useState<DisplayContent>(EMPTY);
  const [hint, setHint] = useState(true);
  const [ask, setAsk] = useState<AskRequest | null>(null);   // A607
  const [stk, setStk] = useState<StkView>(() => sanitiseStk(null));
  const [chan, setChan] = useState<ReturnType<typeof openChannel>>(null);

  useEffect(() => {
    document.title = 'Customer screen';
    const ch = openChannel();
    if (!ch) return;
    setChan(ch);
    ch.onmessage = (e: MessageEvent<ChannelMessage>) => {
      const m = e.data;
      if (m?.type === 'state') setState(sanitiseDisplayState(m.state));
      else if (m?.type === 'content' && m.content && typeof m.content === 'object') setContent(m.content);
      else if (m?.type === 'ask') setAsk(m.ask ? sanitiseAsk(m.ask) : null);
      else if (m?.type === 'stk') setStk(sanitiseStk(m.stk));
    };
    ch.postMessage({ type: 'hello' });
    const here = setInterval(() => { try { ch.postMessage({ type: 'here' }); } catch { /* closed */ } }, 4_000);
    return () => { clearInterval(here); try { ch.close(); } catch { /* closed */ } };
  }, []);
  // The one instruction a browser needs: put this window on the customer's screen yourself. Gone after a while, or on F11.
  useEffect(() => {
    const t = setTimeout(() => setHint(false), 20_000);
    const off = () => { if (window.innerHeight >= screen.height - 2) setHint(false); };
    window.addEventListener('resize', off);
    return () => { clearTimeout(t); window.removeEventListener('resize', off); };
  }, []);

  return (
    <>
      <CustomerScreenView state={state} content={content} slides={content.slides.map((s) => s.url)} />
      {stk.stage !== 'idle' && !ask && <StkBanner stk={stk} />}
      {ask && chan && (
        <CustomerAskForm key={ask.id} ask={ask}
          onSubmit={(v) => {
            const c = cleanAnswer(v, ask);   // checked here for the customer's sake, and again by the POS window
            if ('errors' in c) return c.errors;
            chan.postMessage({ type: 'answer', answer: { id: ask.id, name: v.name, phone: v.phone, kraPin: v.kraPin, save: v.save } });
            return null;
          }}
          onSkip={() => chan.postMessage({ type: 'answer', answer: { id: ask.id, skip: true } })} />
      )}
      {hint && (
        <div data-testid="cs-web-hint" onClick={() => setHint(false)}
          style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', background: '#15202b', color: '#fff',
            padding: '10px 16px', borderRadius: 10, fontFamily: 'system-ui, sans-serif', fontSize: 15, zIndex: 10 }}>
          Drag this window to the customer's screen, then press F11 for full screen.
        </div>
      )}
    </>
  );
}
