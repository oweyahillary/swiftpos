import { useEffect, useState } from 'react';
import { posApi, StaffSession } from './lib/posApi';
import InstallPage from './pages/InstallPage';
import LoginPage from './pages/LoginPage';
import PinPage from './pages/PinPage';
import POSPage from './pages/POSPage';
import ManagerPage from './pages/ManagerPage';
import TechPage from './pages/TechPage';

type AppState = 'loading' | 'install' | 'owner-login' | 'pin' | 'pos' | 'manager' | 'tech';

const MANAGER_ROLES = ['manager', 'supervisor', 'admin', 'branch_manager'];

export default function App() {
  const [state, setState] = useState<AppState>('loading');
  const [session, setSession] = useState<{ user: any; business: any } | null>(null);
  const [staff, setStaff] = useState<StaffSession | null>(null);

  // On boot — first decide whether the device has been configured at all.
  // No config -> install screen (open, because there's nothing to protect yet).
  // Config present -> the normal owner/PIN flow against the configured server.
  //
  // owner/device session persists; staff must always re-enter PIN. We
  // deliberately do NOT auto-resume a staff session after a restart, so an
  // unattended reboot can't silently resume whoever was last logged in.
  const boot = async () => {
    try {
      const configured = await posApi.config.isConfigured();
      if (!configured) { setState('install'); return; }

      const owner = await posApi.auth.getSession();
      if (!owner) { setState('owner-login'); return; }
      setSession(owner);

      // Discard any persisted staff session from a previous run.
      await posApi.auth.clearStaffSession();
      setState('pin');
    } catch {
      setState('owner-login');
    }
  };

  useEffect(() => { boot(); }, []);

  // Install screen finished writing config -> continue the normal boot path.
  const handleInstallComplete = () => {
    setState('loading');
    boot();
  };

  // Owner email/password succeeded -> go to PIN pad for staff.
  const handleOwnerLogin = (s: { user: any; business: any }) => {
    setSession(s);
    setStaff(null);
    setState('pin');
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

  // Staff PIN verified → route by role.
  const handleStaffLogin = (s: StaffSession) => {
    setStaff(s);
    setState(hasManagerRights(s) ? 'manager' : 'pos');
  };

  // End the current staff shift -> back to PIN pad (owner stays signed in).
  const handleEndShift = async () => {
    await posApi.auth.clearStaffSession();
    setStaff(null);
    setState('pin');
  };

  // Full sign-out -> clears owner + staff, back to email login.
  const handleSignOut = async () => {
    await posApi.auth.logout();
    setSession(null);
    setStaff(null);
    setState('owner-login');
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

  if (state === 'owner-login') {
    return <LoginPage onLogin={handleOwnerLogin} />;
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

  if (state === 'manager' && staff) {
    return (
      <ManagerPage
        business={session!.business}
        staff={staff}
        onOpenPOS={() => setState('pos')}
        onLogout={handleEndShift}
        onSwitchAccount={handleSignOut}
      />
    );
  }

  return (
    <POSPage
      business={session!.business}
      onLogout={handleEndShift}
      // Cashiers get no button at all — the tools they can't use shouldn't be
      // visible, and ManagerPage gates each tab on its own permission anyway.
      onOpenManager={hasManagerRights(staff) ? () => setState('manager') : undefined}
      canManagePrinters={hasManagerRights(staff)}
    />
  );
}
