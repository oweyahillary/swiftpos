/**
 * CloudPausedScreen — A584 (2026-10-23): the plain screen over the whole dashboard when the cloud has paused this business.
 *
 * Owner: "after 7 days the access gets revoked immediately, no warning for web". There is no countdown or banner before it
 * (the client has the invoice by email); once the cloud answers any web request 403 CLOUD_ACCESS_PAUSED (lib/api.ts fires
 * 'zaptill:cloud-paused') this covers every page: "Your ZapTill cloud access is paused. Call 0717 675 635 to renew." — no
 * blame, no dates. A trial that ended reads its own words (CLOUD_TRIAL_ENDED). Sign out is the only action; the tills are
 * not affected. A recorded payment opens the cloud at once — the next sign-in (or a reload) works.
 */
import { useEffect, useState } from 'react';
import { pausedWords, type PausedCode } from '../lib/cloudPaused';

export default function CloudPausedScreen() {
  const [code, setCode] = useState<PausedCode | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      if (window.location.pathname.startsWith('/login')) return;   // the sign-in page shows its own card
      const c = (e as CustomEvent<{ code?: string }>).detail?.code;
      setCode(c === 'CLOUD_TRIAL_ENDED' || c === 'BRANCH_PAUSED' ? c : 'CLOUD_ACCESS_PAUSED');   // A612: a branch's own
    };
    window.addEventListener('zaptill:cloud-paused', on);
    return () => window.removeEventListener('zaptill:cloud-paused', on);
  }, []);
  if (!code) return null;
  const w = pausedWords(code);
  const signOut = () => {
    try { window.dispatchEvent(new CustomEvent('swiftpos:session-expired')); } catch { /* the reload below */ }
    window.location.assign('/login');
  };
  return (
    <div data-testid="cloud-paused" data-theme-lock="dark" role="alertdialog" aria-modal="true" aria-labelledby="cloud-paused-title"
      className="fixed inset-0 z-[1000] bg-[#080c14] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-[#0f172a] border border-[#1e2d45] rounded-2xl p-8 text-center space-y-5">
        <div className="mx-auto w-14 h-14 rounded-full bg-[#1e293b] flex items-center justify-center" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round"><line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" /></svg>
        </div>
        <div>
          <h2 id="cloud-paused-title" className="text-white font-bold text-xl mb-2">{w.title}</h2>
          <p className="text-[#94a3b8] text-sm leading-relaxed">{w.body}</p>
        </div>
        <a href="tel:+254717675635" className="block w-full bg-action-500 hover:bg-action-400 text-black font-semibold text-sm rounded-xl py-2.5">Call 0717 675 635</a>
        <button onClick={signOut} className="w-full bg-[#1e293b] hover:bg-[#334155] text-white text-sm font-medium rounded-xl py-2.5">Sign out</button>
      </div>
    </div>
  );
}
