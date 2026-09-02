import { useEffect, useState } from 'react';
import { posApi, StaffSession } from './lib/posApi';
import InstallPage from './pages/InstallPage';
import EnrolPage from './pages/EnrolPage';
import PinPage from './pages/PinPage';
import LockCurtain from './components/LockCurtain';
import POSPage from './pages/POSPage';
import ManagerPage from './pages/ManagerPage';
import TechPage from './pages/TechPage';

type AppState = 'loading' | 'install' | 'enrol' | 'pin' | 'pos' | 'manager' | 'tech';

const MANAGER_ROLES = ['manager', 'supervisor', 'admin', 'branch_manager'];

export default function App() {
  const [state, setState] = useState<AppState>('loading');
  const [session, setSession] = useState<{ user: any; business: any } | null>(null);
  const [staff, setStaff] = useState<StaffSession | null>(null);
  // A52 — the idle lock. A CURTAIN over whatever is mounted, never a reset: the
  // cart and the part-entered payment stay exactly where they are behind it.
  const [locked, setLocked] = useState(false);

  // On boot — first decide whether the device has been configured at all.
  // No config -> install screen (open, because there's nothing to protect yet).
  // Config present -> the normal enrol/PIN flow against the configured server.
  //
  // owner/device session persists; staff must always re-enter PIN. We
  // deliberately do NOT auto-resume a staff session after a restart, so an
  // unattended reboot can't silently resume whoever was last logged in.
  const boot = async () => {
    try {
      const configured = await posApi.config.isConfigured();
      if (!configured) { setState('install'); return; }

      const owner = await posApi.auth.getSession();
      // A158: a configured-but-session-less till re-provisions via a one-time
      // enrolment code — never the owner's email/password.
      if (!owner) { setState('enrol'); return; }
      setSession(owner);

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

  // Does this staff member get the manager tools? Used both to route after PIN
  // entry and to decide whether the POS screen offers a way back to them.
  //
  // The wildcard matters: ManagerPage gates each of its own tabs with
  // `perms['*'] === true || perms[key] === true`, so an owner carrying '*' can
  // see every tab — but this check didn't recognise '*' at all. Anyone granted
  // blanket permission rather than a named role or an explicit
  // 'settings.manage' was therefore routed to the till and, once the Manager
  // button became the way back, had no route to the manager screen at all.
  const hasManagerRights = (s: StaffSession | null) => {
    if (!s) return false;
    const perms = (s.permissions ?? {}) as Record<string, unknown>;
    return MANAGER_ROLES.includes((s.role ?? '').toLowerCase())
      || perms['*'] === true
      || perms['settings.manage'] === true;
  };

  // Which surface is showing decides the threshold — 5 minutes on the manager
  // screens (Close Day, Close Branch, Staff, Receipt, and settings.manage also
  // gates till revocation, A46), 10 on the POS. null everywhere else, because
  // locking the PIN pad, the owner login, the installer or the tech console is
  // meaningless.
  useEffect(() => {
    const surface = state === 'manager' ? 'manager' : state === 'pos' ? 'pos' : null;
    void posApi.idle.setSurface(surface);
  }, [state]);

  useEffect(() => posApi.idle.onLock(() => setLocked(true)), []);

  // Staff PIN verified → route by role.
  const handleStaffLogin = (s: StaffSession) => {
    setStaff(s);
    setState(hasManagerRights(s) ? 'manager' : 'pos');
  };

  // End the current staff shift -> back to PIN pad (owner stays signed in).
  const handleEndShift = async () => {
    await posApi.auth.clearStaffSession();
    setStaff(null);
    setLocked(false);          // never leave a curtain over the PIN pad
    await posApi.idle.clear();
    setState('pin');
  };

  // Sign out the cashier -> clears the STAFF session only and returns to the PIN
  // pad. A158: the device stays enrolled — its session is the terminal identity,
  // and de-enrolling a till is a deliberate act, not a routine sign-out button.
  const handleSignOut = async () => {
    await posApi.auth.clearStaffSession();
    setStaff(null);
    setLocked(false);
    await posApi.idle.clear();
    setState('pin');
  };

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state === 'install') {
    return <InstallPage onComplete={handleInstallComplete} />;
  }

  if (state === 'enrol') {
    return <EnrolPage onComplete={handleEnrolComplete} />;
  }

  if (state === 'pin') {
    return (
      <PinPage
        businessName={session?.business?.name ?? 'SwiftPOS'}
        onStaffLogin={handleStaffLogin}
        onBackToOwner={handleSignOut}
        onTechUnlock={() => setState('tech')}
      />
    );
  }

  if (state === 'tech') {
    return <TechPage onExit={() => setState('pin')} />;
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
    />
  ) : null;

  if (state === 'manager' && staff) {
    return (
      <>
      <ManagerPage
        business={session!.business}
        staff={staff}
        onOpenPOS={() => setState('pos')}
        onLogout={handleEndShift}
        onSwitchAccount={handleSignOut}
      />
      {curtain}
      </>
    );
  }

  return (
    <>
    <POSPage
      business={session!.business}
      onLogout={handleEndShift}
      // Cashiers get no button at all — the tools they can't use shouldn't be
      // visible, and ManagerPage gates each tab on its own permission anyway.
      onOpenManager={hasManagerRights(staff) ? () => setState('manager') : undefined}
      canManagePrinters={hasManagerRights(staff)}
    />
    {curtain}
    </>
  );
}
