import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API_URL } from '../lib/config';
import { TOKEN_KEYS } from '../lib/api';
import { HELP_TOPICS, HOW_TO, WHO_TO_CALL_TITLE, whoToCallSteps } from '../lib/helpTopics';
import { supportContact, displayPhone, whatsappNumber, type SupportContact } from '../lib/support';

/**
 * HelpPage — 0.6.35 (A384): "What to do when", on the web (/help). The same owner-approved words as the till's Help
 * screen (shared/helpTopics.ts) and the same A4 card (Print).
 *
 * Open to anyone — a locked-out owner or cashier needs it most. Signed in, it shows the shop's own tech (allocated in the
 * admin portal); otherwise, or when the shop has none, SwiftPOS support's numbers (shared/support.ts). A plain fetch, not
 * `api`: a missing or expired session here must never bounce to the sign-in page.
 */
export default function HelpPage() {
  const [contact, setContact] = useState<SupportContact>(() => supportContact(null));
  const [open, setOpen] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);   // A422 part 2: a step's picture, full size

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEYS.ownerAccess) || localStorage.getItem(TOKEN_KEYS.posAccess);
    if (!token) return;
    fetch(`${API_URL}/api/business/support`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setContact(supportContact(j.support)); })
      .catch(() => { /* ZapTill support's numbers stay */ });
  }, []);

  const phones = contact.phones.map(displayPhone);
  const topics = [...HELP_TOPICS, { id: 'call', title: WHO_TO_CALL_TITLE, steps: whoToCallSteps(contact.name, phones) }];
  const wa = whatsappNumber(contact.phones[0]);

  return (
    <div data-theme-lock="dark" className="min-h-screen bg-[#080c14] text-gray-100 px-4 py-8" data-testid="help-page">
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
      <div className="max-w-3xl mx-auto space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold text-white">Help — what to do when…</h1>
            <p className="text-sm text-gray-400 mt-1">For the till and the web. The till has the same Help, and it works without internet.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => window.print()} data-testid="help-print"
              className="text-sm px-3 py-2 rounded-lg border border-white/15 text-gray-200 hover:bg-white/5">Print A4 card</button>
            <Link to="/login" className="text-sm px-3 py-2 rounded-lg border border-white/15 text-gray-200 hover:bg-white/5">Back</Link>
          </div>
        </div>

        <div className="rounded-xl border border-white/15 bg-white/5 px-5 py-4" data-testid="help-contact">
          <p className="text-xs uppercase tracking-wide text-gray-400">{contact.assigned ? 'Your technician' : 'Call for help'}</p>
          <p className="text-base font-semibold text-white mt-1">{contact.name}</p>
          <p className="text-2xl font-bold tracking-wide text-white mt-1">
            {contact.phones.map((p, i) => (
              <span key={p}>{i > 0 && <span className="text-gray-500">  ·  </span>}<a href={`tel:${p}`} className="hover:underline">{displayPhone(p)}</a></span>
            ))}
          </p>
          {wa && (
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-block text-sm text-gray-300 hover:text-white underline mt-2">
              WhatsApp {displayPhone(contact.phones[0])}
            </a>
          )}
        </div>

        {/* A422: step by step — the everyday tasks, then "What to do when" below. */}
        {zoom && (
          <div className="fixed inset-0 z-[90] bg-black/85 flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setZoom(null)} data-testid="help-img-zoom">
            <img src={`/help-img/${zoom}`} alt="" className="max-w-full max-h-full rounded-lg shadow-2xl" />
          </div>
        )}
        <h3 className="text-xs uppercase tracking-wide text-gray-400 pt-2" data-testid="help-howto">How to — step by step</h3>
        {[...HOW_TO, { id: '__what', title: '', steps: [] }, ...HELP_TOPICS].map((t) => t.id === '__what' ? (
          <h3 key={t.id} className="text-xs uppercase tracking-wide text-gray-400 pt-3">What to do when…</h3>
        ) : (
          <div key={t.id} className="rounded-xl border border-white/10 bg-white/[0.03]">
            <button onClick={() => setOpen(open === t.id ? null : t.id)} data-testid={`help-topic-${t.id}`}
              className="w-full flex items-center justify-between px-5 py-3 text-left">
              <span className="font-medium text-white">{t.title}</span>
              <span className="text-gray-400">{open === t.id ? '−' : '+'}</span>
            </button>
            {open === t.id && (
              <ol className="list-decimal pl-10 pr-5 pb-4 space-y-1.5 text-sm text-gray-300">
                {t.steps.map((s, i) => {
                  // A422 part 2: the real screen for this step (shipped with the app; tap to see it full size).
                  const img = (t as { images?: Array<string | null> }).images?.[i];
                  return (
                    <li key={i}>
                      {s}
                      {img && (
                        <button type="button" onClick={() => setZoom(img)} className="block mt-2 mb-1" data-testid="help-step-img">
                          <img src={`/help-img/${img}`} alt={s} loading="lazy"
                            className="w-full max-w-xl rounded-lg border border-gray-700 shadow-lg hover:border-gray-500" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        ))}
      </div>

      <div className="help-card" aria-hidden>
        <h1>What to do when…</h1>
        <div className="who">Help: {contact.name} — {phones.join(' or ')} (call or WhatsApp)</div>
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
