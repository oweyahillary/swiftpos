/**
 * PinScreen — the Shop POS's door: a person enters their PIN (Till stage 1, online; shop/pinSignIn.ts), and the web POS
 * screens open as them. Locking the POS (its 🔒 Lock) comes back here. Staff, managers and owners alike use their PIN on a
 * POS (docs/ANDROID-APP-DESIGN.md §2) — nobody signs in with an email here.
 *
 * Arriving here ends the last person's web POS sign-in on this tablet (their tokens are removed from the page's storage):
 * a person's sign-in never outlives their turn on a POS (A415).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLongPress } from '../../shop/useLongPress';
import { signInWithPin } from '../../shop/pinSignIn';
import type { PosSession } from '../../shop/tillSession';
import { PIN_MAX, PIN_MIN } from '../../shop/rules';
import { applyShopBrand } from '../../shop/brandTheme';
import { beginOfflineSignIn, readRoster, type RosterStaff } from '../../shop/offlinePin';
import { bcryptVerify } from '../../shop/pinVerify';
import { holdPin, clearHeldPin } from '../../shop/offlineUpgrade';
import { refreshRoster } from '../../shop/roster';

/** The web POS screens keep the person's tokens here (apps/dashboard lib/api.ts TOKEN_KEYS). */
const PERSON_TOKENS = ['swiftpos_pos_token', 'swiftpos_pos_refresh_token', 'swiftpos_access_token', 'swiftpos_refresh_token'];

function forgetLastPerson(): void {
  try {
    for (const k of PERSON_TOKENS) localStorage.removeItem(k);
    const drop: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k?.startsWith('swiftpos_cashier_session')) drop.push(k); }
    drop.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage unavailable: nothing kept either */ }
}

/** The client's logo, cached by the web POS from pos/init after the first sign-in (localStorage); '' until then → the Z mark. */
function readShopLogo(): string {
  try { return localStorage.getItem('swiftpos_shop_logo') || ''; } catch { return ''; }
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export default function PinScreen({ till, version, online }: { till: PosSession; version: string; online: boolean }) {
  const navigate = useNavigate();
  // Hidden technician door to This device (printer setup, Reset app, Join again): long-press the header, as the desktop
  // hides its tech page behind a long-press on the logo. No visible link — a cashier never sees it.
  const techDoor = useLongPress(() => navigate('/pos/device'));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Till stage 2 offline sign-in: the cached roster (empty until this POS has been online once), and the person picked —
  // offline the cloud is not there to resolve a PIN to a person, so the technician's roster is shown to pick a name first.
  const [roster, setRoster] = useState<RosterStaff[]>([]);
  const [picked, setPicked] = useState<RosterStaff | null>(null);
  const logo = readShopLogo();
  // A fresh PIN screen means the last person's turn is over (start, Lock, or Sign out): forget them, and drop any held
  // offline PIN so a reconnect never upgrades a signed-out session (shop/offlineUpgrade.ts).
  useEffect(() => { forgetLastPerson(); void clearHeldPin(); applyShopBrand(); }, []);
  useEffect(() => { void readRoster(till.branchId).then(setRoster).catch(() => {}); }, [till.branchId]);

  const press = (k: (typeof KEYS)[number]) => {
    setProblem('');
    if (k === 'clear') setPin('');
    else if (k === 'back') setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < PIN_MAX ? p + k : p));
  };

  const signIn = async () => {
    if (pin.length < PIN_MIN || busy) return;
    setBusy(true); setProblem('');
    try {
      let session;
      if (online) {
        session = await signInWithPin(pin, version);   // the cloud resolves the PIN to the person (Till stage 1)
        void refreshRoster();   // we are online with a working session — cache the branch roster so the NEXT sign-in works offline
      } else {
        if (!picked) { setProblem('Pick who is signing in.'); setBusy(false); return; }
        // Offline: the PIN is checked LOCALLY against the cached bcrypt verifier (a wrong PIN is refused here, now), then a
        // provisional session is granted; the PIN is HELD and re-verified with the cloud when the connection returns.
        const { session: s, held } = beginOfflineSignIn(roster, till, picked.id, pin, bcryptVerify);
        await holdPin(held);
        session = s;
      }
      const pos = await import('@zaptill/dashboard-pos');
      pos.storeCashierSession(session);
      navigate('/pos/cashier');
    } catch (e) {
      setPin('');
      setProblem(e instanceof Error ? e.message : String(e));   // PinRefused / OfflinePinRefused / no connection: already in words
    } finally { setBusy(false); }
  };

  return (
    <main className="screen pin-screen">
      {/* A vertical stack, like the desktop PinPage / lock screen (owner, 2026-11-09 — "Logo, branch, enter PIN, keypad"):
          the client logo on top, then the business · branch, then the prompt and the pad. The till name is not shown — the
          branch already says where this is, and a cashier needs the name, not the terminal id. */}
      <header className="brand" {...techDoor}>
        {logo
          ? <img className="brand-logo" src={logo} alt="" />
          : <span className="mark" aria-hidden="true">Z</span>}
        <span>{till.businessName}{till.branchName ? ` · ${till.branchName}` : ''}</span>
      </header>
      {!online && !picked ? (
        roster.length === 0 ? (
          <>
            <h1>Offline</h1>
            <p className="note">No staff are saved on this POS yet. Connect it to the internet once and sign in while online — after that, staff can sign in here with no connection.</p>
          </>
        ) : (
          <>
            <h1>Who's signing in?</h1>
            <p className="note">No connection — pick your name, then enter your PIN. The sale is saved and syncs when the connection is back.</p>
            <div className="roster-pick">
              {roster.map((s) => (
                <button key={s.id} className="choice" disabled={busy} onClick={() => { setPicked(s); setPin(''); setProblem(''); }}>
                  <span className="choice-title">{s.name}</span>
                  {s.role && <span className="choice-detail">{s.role}</span>}
                </button>
              ))}
            </div>
          </>
        )
      ) : (
        <>
          <h1>{online ? 'Enter your PIN' : `${picked?.name} · enter your PIN`}</h1>
          <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
            {Array.from({ length: Math.max(PIN_MIN, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
          </div>
          <div className="pin-pad">
            {KEYS.map((k) => (
              <button key={k} className="pin-key" disabled={busy} onClick={() => press(k)}>
                {k === 'clear' ? 'Clear' : k === 'back' ? '⌫' : k}
              </button>
            ))}
          </div>
          {problem && <p className="problem" role="alert">{problem}</p>}
          <button className="primary" disabled={busy || pin.length < PIN_MIN} onClick={() => void signIn()}>{busy ? 'Signing in…' : online ? 'Sign in' : 'Sign in offline'}</button>
          {!online && <button className="ghost" disabled={busy} onClick={() => { setPicked(null); setPin(''); setProblem(''); }}>← Someone else</button>}
        </>
      )}
      {/* The build, so a tester can tell one install from the next at a glance (owner, 2026-11-11). */}
      <p className="pin-version">ZapTill v{version}</p>
    </main>
  );
}
