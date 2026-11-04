/**
 * CustomerDisplayPage.tsx — A606: the customer screen's window (main/customerDisplayWire.ts opens it on the second
 * monitor at #/customer-display). Its own chunk: the POS's main chunk never carries it (test/customer-display-a606).
 *
 * It only listens: the state main pushes ('customerDisplay:state', already cleaned), the content main lets through (the
 * premium gate is in main), and each slideshow image once, by its key, from this PC's copy — never the network.
 *
 * A607: on a touch screen (premium), "Add your details" / the M-Pesa number when the cashier asks (main sends the cleaned
 * request); what the customer types goes back through main, which checks it and hands it to the cashier to accept. And the
 * M-Pesa prompt's progress ("Waiting for M-Pesa… (check your phone)", "Paid ✓", "Not completed").
 */
import { useEffect, useRef, useState } from 'react';
import { posApi } from '../lib/posApi';
import CustomerScreenView from '@zaptill/ui/CustomerScreenView';
import { idleState, sanitiseDisplayState, gateDisplayContent, type DisplayState, type DisplayContent } from '@zaptill/core/customerScreen';
import CustomerAskForm, { StkBanner } from '@zaptill/ui/CustomerAskForm';   // A607
import { sanitiseAsk, sanitiseStk, type AskRequest, type StkView } from '@zaptill/core/customerDetails';

type Content = DisplayContent & { slideKeys?: string[] };
const EMPTY: Content = gateDisplayContent({ businessName: null, themeId: null, logo: null, primaryHex: null, secondaryHex: null,
  accentHex: null, licensed: false, slides: null, mpesa: null });

export default function CustomerDisplayPage() {
  const [state, setState] = useState<DisplayState>(() => idleState());
  const [content, setContent] = useState<Content>(EMPTY);
  const [slides, setSlides] = useState<string[]>([]);
  const images = useRef(new Map<string, string>());
  const [ask, setAsk] = useState<AskRequest | null>(null);   // A607
  const [stk, setStk] = useState<StkView>(() => sanitiseStk(null));

  useEffect(() => {
    document.title = 'Customer screen';
    const api = posApi.customerDisplay;
    api.current().then((s) => setState(sanitiseDisplayState(s))).catch(() => {});
    const off = api.onState((s) => setState(sanitiseDisplayState(s)));
    // A607: the cashier's request (cleaned in main, and again here) and the M-Pesa prompt's progress.
    const offAsk = api.onAsk((a) => setAsk(a ? sanitiseAsk(a) : null));
    const offStk = api.onStk((v) => setStk(sanitiseStk(v)));
    return () => { off(); offAsk(); offStk(); };
  }, []);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const c = await posApi.customerDisplay.content().catch(() => null) as Content | null;
      if (!live || !c) return;
      setContent(c);
      const keys = Array.isArray(c.slideKeys) ? c.slideKeys : [];
      for (const k of keys) {
        if (images.current.has(k)) continue;
        const src = await posApi.customerDisplay.slide(k).catch(() => null);
        if (src) images.current.set(k, src);
      }
      for (const k of [...images.current.keys()]) if (!keys.includes(k)) images.current.delete(k);
      if (live) setSlides(keys.map((k) => images.current.get(k)).filter((x): x is string => !!x));
    };
    void load();
    const off = posApi.pos.onCatalogueChanged(() => { void load(); });   // a pull may change the name, the look, the slides
    return () => { live = false; off(); };
  }, []);

  return (
    <>
      <CustomerScreenView state={state} content={content} slides={slides} />
      {stk.stage !== 'idle' && !ask && <StkBanner stk={stk} />}
      {ask && (
        <CustomerAskForm key={ask.id} ask={ask} keysOnly
          onSubmit={async (v) => {
            const r = await posApi.customerDisplay.answer({ id: ask.id, name: v.name, phone: v.phone, kraPin: v.kraPin, save: v.save }).catch(() => null);
            if (!r) return { form: 'Something went wrong — please ask the cashier.' };
            return r.ok ? null : r.errors;
          }}
          onSkip={() => { void posApi.customerDisplay.answer({ id: ask.id, skip: true }).catch(() => {}); }} />
      )}
    </>
  );
}
