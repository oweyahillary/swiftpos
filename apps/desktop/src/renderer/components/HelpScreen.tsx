import { useEffect, useState } from 'react';
import { posApi } from '../lib/posApi';
import { HELP_TOPICS, WHO_TO_CALL_TITLE, whoToCallSteps } from '../../shared/helpTopics';
import { displayPhone, DEFAULT_SUPPORT_NAME, DEFAULT_SUPPORT_PHONES } from '../../shared/support';

/**
 * HelpScreen — 0.6.35 (A384): "What to do when", on the till, offline.
 *
 * Opened from the PIN pad (a locked-out cashier needs it most), the POS and the manager screens. The words are the
 * owner-approved text (shared/helpTopics.ts); "Who to call" is the shop's own tech, allocated in the admin portal and
 * pulled with the catalogue, or SwiftPOS support's numbers (shared/support.ts). Nothing here needs the internet.
 *
 * "Print A4 card" prints every topic on one page (the system print dialog — any office printer, not the receipt printer),
 * for the wall by the till.
 */
interface Props {
  businessName: string;
  onClose: () => void;
}

type HelpInfo = { contact: { name: string; phones: string[]; assigned: boolean }; till: string | null; version: string };

const FALLBACK: HelpInfo = {
  contact: { name: DEFAULT_SUPPORT_NAME, phones: [...DEFAULT_SUPPORT_PHONES], assigned: false },
  till: null,
  version: posApi.version,
};

export default function HelpScreen({ businessName, onClose }: Props) {
  const [info, setInfo] = useState<HelpInfo>(FALLBACK);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    posApi.pos.help().then((h) => h && setInfo(h)).catch(() => { /* ZapTill support's numbers stay */ });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const phones = info.contact.phones.map(displayPhone);
  const callSteps = whoToCallSteps(info.contact.name, phones);
  const topics = [...HELP_TOPICS, { id: 'call', title: WHO_TO_CALL_TITLE, steps: callSteps }];

  return (
    <div className="fixed inset-0 z-[70] bg-gray-950 text-gray-100 flex flex-col help-screen" data-testid="help-screen">
      {/* Printing shows only the A4 card below; the screen shows only the screen. */}
      <style>{`
        .help-card { display: none; }
        @media print {
          @page { size: A4; margin: 12mm; }
          body * { visibility: hidden !important; }
          .help-card, .help-card * { visibility: visible !important; }
          .help-card { display: block !important; position: absolute; inset: 0; color: #000; background: #fff;
            font-family: system-ui, sans-serif; font-size: 10.5pt; line-height: 1.3; }
          .help-card h1 { font-size: 16pt; margin: 0 0 2mm; }
          .help-card .who { border: 2px solid #000; padding: 3mm; margin: 0 0 4mm; font-size: 13pt; font-weight: 700; }
          .help-card .grid { column-count: 2; column-gap: 8mm; }
          .help-card section { break-inside: avoid; margin: 0 0 4mm; }
          .help-card h2 { font-size: 11.5pt; margin: 0 0 1mm; }
          .help-card ol { margin: 0; padding-left: 5mm; }
        }
      `}</style>

      <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-gray-800">
        <div>
          <h1 className="text-lg font-semibold">Help — what to do when…</h1>
          <p className="text-xs text-gray-400 mt-0.5">
            {businessName}{info.till ? ` · Till ${info.till}` : ''} · ZapTill v{info.version} · works without internet
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => window.print()} data-testid="help-print"
            className="text-sm px-3 py-2 rounded-lg border border-gray-700 hover:bg-gray-800">
            Print A4 card
          </button>
          <button onClick={onClose} data-testid="help-close"
            className="text-sm px-4 py-2 rounded-lg bg-action-600 hover:bg-action-500 text-white">
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-3xl mx-auto space-y-3">
          {/* Who to call — always visible, the first thing a stuck cashier needs. */}
          <div className="rounded-xl border border-action-700 bg-gray-900 px-5 py-4" data-testid="help-contact">
            <p className="text-xs uppercase tracking-wide text-gray-400">{info.contact.assigned ? 'Your technician' : 'Call for help'}</p>
            <p className="text-base font-semibold mt-1">{info.contact.name}</p>
            <p className="text-2xl font-bold tracking-wide mt-1">{phones.join('  ·  ')}</p>
            <p className="text-xs text-gray-400 mt-1">Call or WhatsApp. Have ready the shop name, this till's name and version (above) and a photo of the error.</p>
          </div>

          {HELP_TOPICS.map((t) => (
            <div key={t.id} className="rounded-xl border border-gray-800 bg-gray-900">
              <button onClick={() => setOpen(open === t.id ? null : t.id)} data-testid={`help-topic-${t.id}`}
                className="w-full flex items-center justify-between px-5 py-3 text-left">
                <span className="font-medium">{t.title}</span>
                <span className="text-gray-400">{open === t.id ? '−' : '+'}</span>
              </button>
              {open === t.id && (
                <ol className="list-decimal pl-10 pr-5 pb-4 space-y-1.5 text-sm text-gray-200">
                  {t.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* The printed card: every topic, open, on one A4 page. */}
      <div className="help-card" aria-hidden>
        <h1>{businessName} — what to do when…</h1>
        <div className="who">Help: {info.contact.name} — {phones.join(' or ')} (call or WhatsApp)</div>
        <div className="grid">
          {topics.map((t, n) => (
            <section key={t.id}>
              <h2>{n + 1}. {t.title}</h2>
              <ol>{t.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
