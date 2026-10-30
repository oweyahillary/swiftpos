import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { posApi, StaffSession } from './lib/posApi';
import PinPage from './pages/PinPage';
import LockCurtain from './components/LockCurtain';
import POSPage from './pages/POSPage';
import { can, backOffice, maySell, SELL_REFUSAL } from './lib/access';   // A490: the one rule — permissions, never a role's name
// A519: React.lazy that can import a failed chunk again (Retry), and the boundary that says a screen could not load.
import { retryLazy as lazy } from './lib/retryLazy';
import ScreenBoundary from './components/ScreenBoundary';
import UpdateBanner from './pages/UpdateBanner';
import JoinPrompt from './components/JoinPrompt';   // A427
import OnScreenKeyboard from './components/OnScreenKeyboard';   // A417
import { computeThemeVars, applyThemeVars, stripBackground } from './lib/themeVars';
import { schedulePreload, browserPreloadDeps } from './lib/preloadScreens';   // A517

// A517: the screens a till opens now and then are their own chunks, loaded when first opened — the PIN screen and the
// POS (and what a sale needs: cart, payment, receipt, held orders, the shift panel) are in the main chunk and come up
// without parsing them, nor hold them in memory. The setup screens (install, enrolment) are needed once per machine;
// the manager screens (every tab: Overview, reports, staff, stock, wastage, offers, close day, settings…) are fetched in
// the background once the till is quiet on a machine with memory to spare (lib/preloadScreens.ts), else when opened.
const loadManagerPage = () => import('./pages/ManagerPage');
const ManagerPage = lazy(loadManagerPage);
const TechPage = lazy(() => import('./pages/TechPage'));
const InstallPage = lazy(() => import('./pages/InstallPage'));
const EnrolPage = lazy(() => import('./pages/EnrolPage'));
const HelpScreen = lazy(() => import('./components/HelpScreen'));   // 0.6.35 (A384)

/** A517: while a screen's chunk loads — the same dark screen and spinner as the start, so nothing jumps. */
function ScreenLoading({ overlay = false }: { overlay?: boolean }) {
  return (
    <div className={`${overlay ? 'fixed inset-0 z-50 bg-gray-950/80' : 'min-h-screen bg-gray-950'} flex items-center justify-center`}>
      <div className="w-8 h-8 border-2 border-action-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
// A519: a chunk that cannot load (missing, damaged) shows "This screen could not load — Retry / Back" instead of a blank
// window (components/ScreenBoundary.tsx), logged through log:renderer.
const Lazy = ({ children, overlay, name = 'screen', onBack, backLabel }: {
  children: ReactNode; overlay?: boolean; name?: string; onBack?: () => void; backLabel?: string;
}) =>
  <ScreenBoundary name={name} onBack={onBack} backLabel={backLabel} overlay={overlay}>
    <Suspense fallback={<ScreenLoading overlay={overlay} />}>{children}</Suspense>
  </ScreenBoundary>;

/**
 * A519: someone whose role cannot sell and has nothing in the back office (a Kitchen person) — a plain screen, not an
 * error and not the manager screens. The words are the same as main's refusal (main/sellGate.ts).
 */
function NoSellScreen({ name, onSignOut, onHelp }: { name: string | null; onSignOut: () => void; onHelp: () => void }) {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6" data-testid="no-sell-screen">
      <div className="max-w-md w-full text-center space-y-5">
        {name && <p className="text-gray-400 text-sm">Signed in as {name}</p>}
        <p className="text-white text-lg leading-relaxed">{SELL_REFUSAL}</p>
        <div className="flex gap-2 justify-center">
          <button onClick={onSignOut} data-testid="no-sell-signout"
            className="px-5 py-2.5 rounded-xl bg-action-500 text-gray-950 font-semibold">Sign out</button>
          <button onClick={onHelp} className="px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 text-sm">Help</button>
        </div>
      </div>
    </div>
  );
}

type AppState = 'loading' | 'install' | 'enrol' | 'pin' | 'pos' | 'manager' | 'tech' | 'nosell';

// A427: on the branch server, "a till wants to join" shows over every screen — PIN pad, till, manager, tech.
// A417: the on-screen keyboard serves every screen too — it opens when a field is tapped with a finger or pen.
export default function App() {
  return (<><AppScreens /><JoinPrompt /><OnScreenKeyboard /></>);
}

function AppScreens() {
  const [state, setState] = useState<AppState>('loading');
  // A405: the Manager tab to open on ("Close day now" on the day-lock banner opens Close Day); null = Overview.
  const [managerTab, setManagerTab] = useState<'dayclose' | null>(null);
  const [session, setSession] = useState<{ till?: { device_id: string | null }; business: any } | null>(null);
  const [staff, setStaff] = useState<StaffSession | null>(null);
  // A52 — the idle lock. A CURTAIN over whatever is mounted, never a reset: the
  // cart and the part-entered payment stay exactly where they are behind it.
  const [locked, setLocked] = useState(false);
  // 0.6.35 (A384): "What to do when" — over whatever is showing (the PIN pad, the POS, the manager screens), offline.
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = () => setHelpOpen(true);

  // A326 (client branding Phase 2): the business's action theme + brand colour, applied as CSS variables on <html>
  // for every screen. Re-read on every landed pull (A321's signal), so an admin switching themes on/off or a new
  // theme reaches the running till within the 20-s check. themeId null (themes OFF) → nothing is overridden.
  const [brandStrip, setBrandStrip] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      posApi.branding.get().then((b) => {
        if (cancelled) return;
        // A544: what this till's branch wears — its override per field, else the business's (main resolves it).
        // A597: + the owner's brand colours, resolved the same way (none while a branch's own theme overrides).
        const t = computeThemeVars(b ? { themeId: b.effective?.themeId ?? b.themeId ?? null, accentHex: b.effective ? b.effective.accentHex : b.accentHex,
          primaryHex: b.effective?.primaryHex ?? null, secondaryHex: b.effective?.secondaryHex ?? null } : null);
        applyThemeVars(t);
        setBrandStrip(stripBackground(t));
      }).catch(() => { /* keep what is applied; the defaults are today's look */ });
    };
    load();
    const unsubscribe = posApi.pos.onCatalogueChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  // A450: the business's name (and currency) follow the cloud — after any pull the screens show the new name at once
  // (owner: renamed on the web, the till kept the old one until it was set up again).
  useEffect(() => posApi.pos.onCatalogueChanged(() => {
    posApi.auth.getSession().then((s: any) => {
      if (!s?.business) return;
      setSession((prev) => (prev && (prev.business?.name !== s.business.name || prev.business?.currency !== s.business.currency)
        ? { ...prev, business: { ...prev.business, name: s.business.name, currency: s.business.currency } } : prev));
    }).catch(() => { /* the next pull */ });
  }), []);
  const strip = brandStrip
    ? <div aria-hidden className="fixed top-0 inset-x-0 h-[3px] z-[60] pointer-events-none" style={{ background: brandStrip }} />
    : null;

  // On boot — first decide whether the device has been configured at all.
  // No config -> install screen (open, because there's nothing to protect yet).
  // Config present -> the normal enrol/PIN flow against the configured server.
  //
  // The till's own session persists (A415: the till itself, never a person); staff must always re-enter PIN. We
  // deliberately do NOT auto-resume a staff session after a restart, so an
  // unattended reboot can't silently resume whoever was last logged in.
  const boot = async () => {
    try {
      const configured = await posApi.config.isConfigured();
      if (!configured) { setState('install'); return; }

      const tillSession = await posApi.auth.getSession();
      // A158: a configured-but-session-less till joins with a one-time
      // enrolment code from ZapTill — never anyone's email/password.
      if (!tillSession) { setState('enrol'); return; }
      setSession(tillSession);

      // Discard any persisted staff session from a previous run.
      await posApi.auth.clearStaffSession();
      setState('pin');
    } catch {
      setState('enrol');
    }
  };

  useEffect(() => { boot(); }, []);

  // Install screen finished writing config -> continue the normal boot path.
  const handleInstallComplete = () => {
    setState('loading');
    boot();
  };

  // Enrolment succeeded (session written) -> re-run boot: it finds the session
  // and lands on the PIN pad. A158.
  const handleEnrolComplete = () => {
    setState('loading');
    boot();
  };

  // Does this staff member get the manager tools? Used both to route after PIN entry and to decide whether the POS
  // screen offers a way back to them. A490: anyone beyond the shop floor (or the owner) — lib/access backOffice — never
  // a role's name; ManagerPage then shows each page by its own key.
  const hasManagerRights = (s: StaffSession | null) => backOffice(s);

  // A490: main stored a fresher permission map for the person signed in (the staff list, a staff token renewal) — read
  // the session again, so a key given or taken away shows at once. Someone no longer back office leaves the manager
  // screens for the till.
  useEffect(() => posApi.auth.onPermissionsChanged(() => {
    posApi.auth.getStaffSession().then((s) => {
      if (!s) return;
      setStaff((prev) => (prev && prev.staff?.id === s.staff?.id ? { ...prev, role: s.role, permissions: s.permissions } : prev));
      // A519: …to the till only if they may sell; else the plain "your role can't sell" screen. Someone on the POS who
      // loses "Sell" stays there — the open bill can still be paid (main/sellGate.ts); the next new sale is refused.
      if (!backOffice(s)) setState((st) => (st === 'manager' ? (maySell(s) ? 'pos' : 'nosell') : st));
      else if (!maySell(s)) setState((st) => (st === 'nosell' ? 'manager' : st));
      else setState((st) => (st === 'nosell' ? 'pos' : st));
    }).catch(() => { /* the next change */ });
  }), []);

  // Which surface is showing decides the threshold — 5 minutes on the manager
  // screens (Close Day, Close Branch, Staff, Receipt, and settings.manage also
  // gates till revocation, A46), 10 on the POS. null everywhere else, because
  // locking the PIN pad, the enrolment screen, the installer or the tech console is
  // meaningless.
  useEffect(() => {
    const surface = state === 'manager' ? 'manager' : state === 'pos' ? 'pos' : null;
    void posApi.idle.setSurface(surface);
  }, [state]);

  useEffect(() => posApi.idle.onLock(() => setLocked(true)), []);

  // A517: the manager screens fetched in the background, once — a few seconds after the PIN screen or the POS settles,
  // at an idle moment, never during the start-up sequence nor on a 4 GB machine (lib/preloadScreens.ts).
  const preloaded = useRef({ done: false });
  useEffect(() => {
    if (state !== 'pin' && state !== 'pos') return;
    const ask = posApi.idle.mayPreload;
    if (!ask) return;
    return schedulePreload(browserPreloadDeps(loadManagerPage, () => ask()), preloaded.current);
  }, [state]);

  // Staff PIN verified → route by role.
  const handleStaffLogin = (s: StaffSession) => {
    setPinNotice(null);
    setStaff(s);
    // A519: someone who may not sell is never routed into the POS: back office → the manager screens (no POS button),
    // anyone else (a Kitchen person) → a plain screen that says why, with Sign out.
    setState(hasManagerRights(s) ? 'manager' : maySell(s) ? 'pos' : 'nosell');
  };

  // End the current staff shift -> back to PIN pad (the till stays joined).
  // A421: a line for the PIN screen after a shift closes ("Shift closed — your count is saved."); gone at the next sign-in.
  const [pinNotice, setPinNotice] = useState<string | null>(null);

  const handleEndShift = async (notice?: unknown) => {
    setPinNotice(typeof notice === 'string' ? notice : null);   // a click event is not a notice
    await posApi.auth.clearStaffSession();
    setStaff(null);
    setLocked(false);          // never leave a curtain over the PIN pad
    await posApi.idle.clear();
    setState('pin');
  };

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-action-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state === 'install') {
    return <Lazy name="setup"><InstallPage onComplete={handleInstallComplete} /></Lazy>;
  }

  if (state === 'enrol') {
    return <Lazy name="enrolment"><EnrolPage onComplete={handleEnrolComplete} /></Lazy>;
  }

  // A517: over the screen in use — while its chunk loads, a dimmed spinner over it (the screen behind stays as it is).
  const help = helpOpen
    ? <Lazy overlay name="help" onBack={() => setHelpOpen(false)} backLabel="Close"><HelpScreen businessName={session?.business?.name ?? 'ZapTill'} onClose={() => setHelpOpen(false)} /></Lazy>
    : null;

  if (state === 'pin') {
    return (
      <>
      <PinPage
        businessName={session?.business?.name ?? 'ZapTill'}
        onStaffLogin={handleStaffLogin}
        onTechUnlock={() => setState('tech')}
        onHelp={openHelp}
        notice={pinNotice}
      />
      {help}
      </>
    );
  }

  if (state === 'tech') {
    return <Lazy name="Tech" onBack={() => setState('pin')} backLabel="Back to the PIN screen"><TechPage onExit={() => setState('pin')} /></Lazy>;
  }

  // The curtain renders ALONGSIDE the screen, not instead of it — see
  // LockCurtain.tsx. ManagerPage/POSPage stay mounted with all their state, so
  // there is no code path that could discard a cart.
  const curtain = locked && staff?.staff ? (
    <LockCurtain
      staffName={staff.staff.name}
      staffId={staff.staff.id}
      branchId={staff.branchId}
      onUnlock={() => setLocked(false)}
      onSignOut={() => { void handleEndShift(); }}   // A446: the curtain's way out — sign out to the PIN screen
    />
  ) : null;

  // A306: the auto-update banner rides alongside the working surface (like the curtain), so a
  // pending update is communicated while staff are logged in — never on the lock/PIN screens.
  // A480: a local sign-in used to carry only `branch` — read either, so the Manager-PIN restart always has the branch.
  if (state === 'nosell') {
    return (<><NoSellScreen name={staff?.staff?.name ?? null} onSignOut={() => { void handleEndShift(); }} onHelp={() => setHelpOpen(true)} />{help}</>);
  }

  // A519: one-tap "Restart & update now" for a back-office person (no PIN); anyone else sees no button.
  const updateBanner = <UpdateBanner branchId={staff?.branchId ?? (staff as any)?.branch?.id ?? null} canRestart={backOffice(staff)} />;

  if (state === 'manager' && staff) {
    return (
      <>
      <Lazy name="manager" onBack={() => { if (maySell(staff)) setState('pos'); else void handleEndShift(); }}
        backLabel={maySell(staff) ? 'Back to the POS' : 'Sign out'}>
      <ManagerPage
        business={session!.business}
        staff={staff}
        initialTab={managerTab ?? undefined}
        // A519: no POS for someone who may not sell (a Storekeeper, an Accountant) — the button shows the reason instead.
        onOpenPOS={maySell(staff) ? () => { setManagerTab(null); setState('pos'); } : undefined}
        onLogout={handleEndShift}
        onHelp={openHelp}
      />
      </Lazy>
      {help}
      {curtain}
      {updateBanner}
      {strip}
      </>
    );
  }

  return (
    <>
    <POSPage
      business={session!.business}
      onLogout={handleEndShift}
      onShiftClosed={handleEndShift}
      // Cashiers get no button at all — the tools they can't use shouldn't be
      // visible, and ManagerPage gates each tab on its own permission anyway.
      onOpenManager={hasManagerRights(staff) ? (tab?: 'dayclose') => { setManagerTab(tab ?? null); setState('manager'); } : undefined}
      canManagePrinters={can(staff, 'stations.manage')}
      reverseRights={{ void: can(staff, 'sales.void'), refund: can(staff, 'sales.refund') }}
      canCloseDay={can(staff, 'shifts.close_day')}
      canDiscount={can(staff, 'sales.discount')}
      canSeeSync={backOffice(staff)}
      canAddExpenseType={can(staff, 'expenses.manage')}
      canSell={maySell(staff)}
      onHelp={openHelp}
    />
    {help}
    {curtain}
    {updateBanner}
    {strip}
    </>
  );
}
