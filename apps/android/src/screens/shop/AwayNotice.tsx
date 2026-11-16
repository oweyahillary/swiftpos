/**
 * AwayNotice — Branch-server bind (migration 192). A thin strip the Shop POS shows when either:
 *   • the owner has DISABLED this tablet (red, blocking words — selling is already refused server-side and by the sell-gate), or
 *   • this tablet is operating AWAY from its own branch server (amber, non-blocking — it keeps selling; this only makes the
 *     move visible so a tablet carried to another, unpaid branch is noticed).
 *
 * Mounted once by ShopPos, over any screen, like SyncStatusBar. It reads serverPresence's snapshot, updating on the
 * presence event (the main path) with a short poll as belt-and-braces.
 */
import { useEffect, useState } from 'react';
import { presence, PRESENCE_EVENT, type PresenceSnapshot } from '../../shop/serverPresence';
import { awayWords, DEVICE_DISABLED_WORDS } from '../../shop/rules';

export default function AwayNotice({ branchName }: { branchName: string | null }) {
  const [snap, setSnap] = useState<PresenceSnapshot>(presence());
  useEffect(() => {
    const on = (e: Event) => setSnap((e as CustomEvent<PresenceSnapshot>).detail ?? presence());
    window.addEventListener(PRESENCE_EVENT, on);
    const timer = setInterval(() => setSnap(presence()), 5000);
    return () => { window.removeEventListener(PRESENCE_EVENT, on); clearInterval(timer); };
  }, []);

  if (snap.disabled) {
    return (
      <div className="away-bar away-disabled" role="alert" data-testid="tablet-disabled">
        <span className="away-dot" aria-hidden="true" />
        <span className="away-text">{DEVICE_DISABLED_WORDS}</span>
      </div>
    );
  }
  if (snap.state === 'away_no_server' || snap.state === 'away_foreign') {
    return (
      <div className="away-bar away-adrift" role="status" aria-live="polite" data-testid="away-notice">
        <span className="away-dot" aria-hidden="true" />
        <span className="away-text">{awayWords(snap.state, branchName)}</span>
      </div>
    );
  }
  return null;
}
