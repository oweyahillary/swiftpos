import { useEffect, useState, useRef } from 'react';
import { posApi, StaffSession } from '../lib/posApi';
import { resolveBranding } from '../../shared/contrast';
import { resolveTheme } from '../../shared/themes';

interface Branch { id: string; name: string; desktop_licensed: boolean; }

interface Props {
  businessName: string;
  onStaffLogin: (s: StaffSession) => void;
  onBackToOwner: () => void;   // full sign-out (switch business / owner)
  onTechUnlock: () => void;    // hidden: long-press logo -> reveal code -> token
  onHelp?: () => void;         // 0.6.35 (A384): "What to do when" — forgot the PIN, locked out, till won't sync
}

const PIN_MAX = 6;
const PIN_MIN = 4;

// The card the accent marks (divider, active PIN dot) sit on — current theme.
// resolveBranding vets the accent's legibility against this; change it here if the
// card colour changes.
const LOCK_SURFACE = '#0d1424';

// SwiftPOS default mark — shown in the logo slot when a client has set no logo.
// Its wordmark is dark (built for a light background), so it renders on a white
// logo-card, the same treatment as client logos.
// C2PA provenance metadata stripped; inlined so it needs no asset pipeline.
const SWIFTPOS_LOGO = "data:image/svg+xml,%3Csvg%20viewBox%3D%22116%2061%20168%20178%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3C%21--%20ZapTill%20App%20Badge%20%C2%B7%20Teal%20%C2%B7%20text%20outlined%20to%20paths%20%28Poppins%29%20--%3E%0A%20%20%3Crect%20x%3D%22168%22%20y%3D%2273%22%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22%230F172A%22%2F%3E%0A%20%20%3Ccircle%20fill%3D%22%230D9488%22%20cx%3D%22223%22%20cy%3D%2284%22%20r%3D%225%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22white%22%20d%3D%22M189.16549999999998%20111.66H198.52749999999997V116.0H183.1515V111.97L192.45149999999998%2098.578H183.1515V94.238H198.52749999999997V98.268Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22white%22%20d%3D%22M217.65449999999998%2094.238V98.485H211.8885V116.0H206.58749999999998V98.485H200.8215V94.238Z%22%2F%3E%0A%20%20%3C%21--%20wordmark%20--%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M143.38%20201.28H153.38V205.0H138.1V201.28L148.14000000000001%20186.68H138.1V182.96H153.38V186.68Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M167.06%20182.6Q169.66%20182.6%20171.60000000000002%20183.62Q173.54000000000002%20184.64%20174.70000000000002%20186.16V182.96H179.3V205.0H174.70000000000002V201.72Q173.54000000000002%20203.28%20171.54000000000002%20204.32Q169.54000000000002%20205.36%20166.98000000000002%20205.36Q164.14000000000001%20205.36%20161.78000000000003%20203.9Q159.42000000000002%20202.44%20158.04000000000002%20199.82Q156.66%20197.2%20156.66%20193.88Q156.66%20190.56%20158.04000000000002%20188.0Q159.42000000000002%20185.44%20161.8%20184.01999999999998Q164.18%20182.6%20167.06%20182.6ZM168.02%20186.56Q166.26000000000002%20186.56%20164.74%20187.42000000000002Q163.22%20188.28%20162.28%20189.94Q161.34%20191.6%20161.34%20193.88Q161.34%20196.16%20162.28%20197.88Q163.22%20199.6%20164.76%20200.5Q166.3%20201.4%20168.02%20201.4Q169.78%20201.4%20171.3%20200.51999999999998Q172.82%20199.64%20173.76%20197.94Q174.70000000000002%20196.24%20174.70000000000002%20193.96Q174.70000000000002%20191.68%20173.76%20190.0Q172.82%20188.32%20171.3%20187.44Q169.78%20186.56%20168.02%20186.56Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%231E293B%22%20d%3D%22M197.54000000000002%20182.6Q200.42000000000002%20182.6%20202.8%20184.01999999999998Q205.18%20185.44%20206.54000000000002%20188.0Q207.9%20190.56%20207.9%20193.88Q207.9%20197.2%20206.54000000000002%20199.82Q205.18%20202.44%20202.8%20203.9Q200.42000000000002%20205.36%20197.54000000000002%20205.36Q195.02%20205.36%20193.06%20204.34Q191.10000000000002%20203.32%20189.86%20201.8V215.48H185.3V182.96H189.86V186.2Q191.02%20184.68%20193.02%20183.64Q195.02%20182.6%20197.54000000000002%20182.6ZM196.54000000000002%20186.56Q194.82000000000002%20186.56%20193.28000000000003%20187.44Q191.74%20188.32%20190.8%20190.0Q189.86%20191.68%20189.86%20193.96Q189.86%20196.24%20190.8%20197.94Q191.74%20199.64%20193.28000000000003%20200.51999999999998Q194.82000000000002%20201.4%20196.54000000000002%20201.4Q198.3%20201.4%20199.84000000000003%20200.5Q201.38000000000002%20199.6%20202.32000000000002%20197.88Q203.26000000000002%20196.16%20203.26000000000002%20193.88Q203.26000000000002%20191.6%20202.32000000000002%20189.94Q201.38000000000002%20188.28%20199.84000000000003%20187.42000000000002Q198.3%20186.56%20196.54000000000002%20186.56Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M230.38000000000002%20177.2V180.92H222.98000000000002V205.0H218.42000000000002V180.92H210.98000000000002V177.2Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M234.38000000000002%20177.12Q234.38000000000002%20175.88%20235.22000000000003%20175.04Q236.06000000000003%20174.2%20237.3%20174.2Q238.50000000000003%20174.2%20239.34000000000003%20175.04Q240.18%20175.88%20240.18%20177.12Q240.18%20178.36%20239.34000000000003%20179.2Q238.50000000000003%20180.04%20237.3%20180.04Q236.06000000000003%20180.04%20235.22000000000003%20179.2Q234.38000000000002%20178.36%20234.38000000000002%20177.12ZM239.54000000000002%20182.96V205.0H234.98000000000002V182.96Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M250.10000000000002%20175.4V205.0H245.54000000000002V175.4Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%230D9488%22%20d%3D%22M260.66%20175.4V205.0H256.1V175.4Z%22%2F%3E%0A%20%20%3C%21--%20tagline%20--%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M150.314%20223.508H148.706V227.0H147.614V218.636H150.314Q151.73%20218.636%20152.468%20219.32Q153.206%20220.004%20153.206%20221.084Q153.206%20222.128%20152.492%20222.81799999999998Q151.778%20223.508%20150.314%20223.508ZM152.09%20221.084Q152.09%20219.536%20150.314%20219.536H148.706V222.608H150.314Q151.226%20222.608%20151.65800000000002%20222.212Q152.09%20221.816%20152.09%20221.084Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M156.154%20222.812Q156.154%20221.588%20156.712%20220.61Q157.27%20219.632%20158.23000000000002%20219.086Q159.19%20218.54%20160.354%20218.54Q161.53%20218.54%20162.49%20219.086Q163.45000000000002%20219.632%20164.002%20220.60399999999998Q164.554%20221.576%20164.554%20222.812Q164.554%20224.048%20164.002%20225.01999999999998Q163.45000000000002%20225.992%20162.49%20226.538Q161.53%20227.084%20160.354%20227.084Q159.19%20227.084%20158.23000000000002%20226.538Q157.27%20225.992%20156.712%20225.014Q156.154%20224.036%20156.154%20222.812ZM163.43800000000002%20222.812Q163.43800000000002%20221.804%20163.036%20221.054Q162.63400000000001%20220.304%20161.93800000000002%20219.89600000000002Q161.24200000000002%20219.488%20160.354%20219.488Q159.466%20219.488%20158.77%20219.89600000000002Q158.074%20220.304%20157.67200000000003%20221.054Q157.27%20221.804%20157.27%20222.812Q157.27%20223.808%20157.67200000000003%20224.564Q158.074%20225.32%20158.776%20225.728Q159.478%20226.136%20160.354%20226.136Q161.23000000000002%20226.136%20161.93200000000002%20225.728Q162.63400000000001%20225.32%20163.036%20224.564Q163.43800000000002%20223.808%20163.43800000000002%20222.812Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M169.08599999999998%20218.636V227.0H167.994V218.636Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M179.522%20227.0H178.42999999999998L174.03799999999998%20220.34V227.0H172.946V218.624H174.03799999999998L178.42999999999998%20225.272V218.624H179.522Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M188.53%20218.636V219.524H186.25V227.0H185.158V219.524H182.86599999999999V218.636Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M196.67%20222.812Q196.67%20221.588%20197.228%20220.61Q197.786%20219.632%20198.74599999999998%20219.086Q199.706%20218.54%20200.87%20218.54Q202.046%20218.54%20203.006%20219.086Q203.966%20219.632%20204.518%20220.60399999999998Q205.07%20221.576%20205.07%20222.812Q205.07%20224.048%20204.518%20225.01999999999998Q203.966%20225.992%20203.006%20226.538Q202.046%20227.084%20200.87%20227.084Q199.706%20227.084%20198.74599999999998%20226.538Q197.786%20225.992%20197.228%20225.014Q196.67%20224.036%20196.67%20222.812ZM203.954%20222.812Q203.954%20221.804%20203.55200000000002%20221.054Q203.15%20220.304%20202.454%20219.89600000000002Q201.758%20219.488%20200.87%20219.488Q199.982%20219.488%20199.286%20219.89600000000002Q198.59%20220.304%20198.188%20221.054Q197.786%20221.804%20197.786%20222.812Q197.786%20223.808%20198.188%20224.564Q198.59%20225.32%20199.292%20225.728Q199.994%20226.136%20200.87%20226.136Q201.746%20226.136%20202.448%20225.728Q203.15%20225.32%20203.55200000000002%20224.564Q203.954%20223.808%20203.954%20222.812Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M213.23799999999997%20218.636V219.524H209.60199999999998V222.344H212.55399999999997V223.232H209.60199999999998V227.0H208.51V218.636Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M221.522%20224.768H222.686Q222.74599999999998%20225.356%20223.17199999999997%20225.75799999999998Q223.59799999999998%20226.16%20224.414%20226.16Q225.194%20226.16%20225.644%20225.76999999999998Q226.094%20225.38%20226.094%20224.768Q226.094%20224.288%20225.82999999999998%20223.988Q225.566%20223.688%20225.17000000000002%20223.53199999999998Q224.774%20223.376%20224.102%20223.196Q223.274%20222.98%20222.776%20222.764Q222.278%20222.548%20221.92399999999998%20222.086Q221.57%20221.624%20221.57%20220.844Q221.57%20220.16%20221.918%20219.632Q222.266%20219.104%20222.896%20218.816Q223.52599999999998%20218.528%20224.34199999999998%20218.528Q225.518%20218.528%20226.268%20219.11599999999999Q227.018%20219.704%20227.114%20220.676H225.914Q225.85399999999998%20220.196%20225.41%20219.82999999999998Q224.966%20219.464%20224.23399999999998%20219.464Q223.54999999999998%20219.464%20223.118%20219.81799999999998Q222.686%20220.172%20222.686%20220.808Q222.686%20221.264%20222.94400000000002%20221.55200000000002Q223.202%20221.84%20223.57999999999998%20221.99Q223.958%20222.14%20224.642%20222.332Q225.47%20222.56%20225.974%20222.78199999999998Q226.47799999999998%20223.004%20226.838%20223.466Q227.198%20223.928%20227.198%20224.72Q227.198%20225.332%20226.874%20225.872Q226.54999999999998%20226.412%20225.914%20226.748Q225.278%20227.084%20224.414%20227.084Q223.58599999999998%20227.084%20222.932%20226.79000000000002Q222.278%20226.496%20221.906%20225.974Q221.534%20225.452%20221.522%20224.768Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M235.75%20225.14H232.102L231.43%20227.0H230.278L233.302%20218.684H234.562L237.574%20227.0H236.422ZM235.43800000000002%20224.252%20233.92600000000002%20220.028%20232.41400000000002%20224.252Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M241.986%20226.112H244.914V227.0H240.894V218.636H241.986Z%22%2F%3E%0A%20%20%3Cpath%20fill%3D%22%2364748B%22%20d%3D%22M249.17%20219.524V222.32H252.218V223.22H249.17V226.1H252.578V227.0H248.078V218.624H252.578V219.524Z%22%2F%3E%0A%3C%2Fsvg%3E";   // ZapTill badge + wordmark (2026-10-03), text outlined to paths (Poppins)

export default function PinPage({ businessName, onStaffLogin, onBackToOwner, onTechUnlock, onHelp }: Props) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  // A334: this sign-in joined a drawer ANOTHER cashier opened on the web POS — say so before selling.
  const [joined, setJoined] = useState<{ session: StaffSession; till: string; who: string; since: string } | null>(null);
  const [loading, setLoading] = useState(true);
  // Two taps to sign the business out. The button only shows on a screen
  // that is already broken, which is exactly when someone is jabbing at it.
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  // ── A295 branding seam ────────────────────────────────────────────────────
  // Until the branding read lands (a later, sync-dependent slice) these are null,
  // so resolveBranding returns the SwiftPOS default: the screen renders today's
  // green look inside the new layout. Wire accentHex / logoDataUri to branding:get
  // when that slice ships — nothing else here changes.
  const [accentHex, setAccentHex] = useState<string | null>(null);
  const [logoDataUri, setLogoDataUri] = useState<string | null>(null);
  // A321: read on mount AND whenever a background pull lands. This read once and never listened, so a
  // till waiting on the PIN screen kept the old colour/logo until someone signed in and out (VERIFY A2;
  // owner 2026-09-23). A cleared branding (null) now returns the screen to the default instead of
  // leaving the stale look; a read ERROR keeps what is shown.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      posApi.branding.get().then((b) => {
        if (cancelled) return;
        // A326: themes ON but no brand colour → the lock screen wears the action theme (the proposal). OFF → unchanged.
        setAccentHex(b?.accentHex ?? (b?.themeId ? resolveTheme(b.themeId).shades[500] : null));
        setLogoDataUri(b?.logoPng ?? null);
      }).catch(() => { /* keep what is on screen; first paint falls back to the ZapTill default */ });
    };
    load();
    const unsubscribe = posApi.pos.onCatalogueChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  const brand = resolveBranding(accentHex, LOCK_SURFACE);

  // ── Hidden tech entry: long-press the logo -> reveal code -> token ──
  const [techStage, setTechStage] = useState<null | 'reveal' | 'token'>(null);
  const [revealInput, setRevealInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [techBusy, setTechBusy] = useState(false);
  const [techErr, setTechErr] = useState('');
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startPress = () => {
    pressTimer.current = setTimeout(() => { setTechErr(''); setRevealInput(''); setTechStage('reveal'); }, 800);
  };
  const cancelPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  const closeTech = () => { setTechStage(null); setRevealInput(''); setTokenInput(''); setTechErr(''); };

  const submitReveal = async () => {
    setTechBusy(true); setTechErr('');
    try {
      const r = await posApi.tech.checkReveal(revealInput.trim());
      if (r.ok) { setTokenInput(''); setTechStage('token'); }
      else setTechErr('Incorrect code');
    } catch (e: any) { setTechErr(e?.message ?? 'Check failed'); }
    finally { setTechBusy(false); }
  };

  const submitToken = async () => {
    setTechBusy(true); setTechErr('');
    try {
      const r = await posApi.tech.openSession(tokenInput.trim());
      if (r.ok) { closeTech(); onTechUnlock(); }
      else setTechErr((r as { ok: false; error: string }).error || 'Invalid token');
    } catch (e: any) { setTechErr(e?.message ?? 'Verification failed'); }
    finally { setTechBusy(false); }
  };
  // Like the web POS: the branch is chosen once and remembered (bound to the
  // device), so the PIN pad doesn't ask again. The cashier-facing "change" is
  // gone (A295 §2 — branch re-bind lives behind the technician gate); the picker
  // still appears on first run or when no valid branch is bound.
  const [showBranchPicker, setShowBranchPicker] = useState(false);

  // Load branches the owner can see; prefer the device's bound branch,
  // else auto-select if only one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await posApi.auth.listBranches();
        if (cancelled) return;
        setBranches(list);
        const cfg = await posApi.config.get().catch(() => null);
        const bound = cfg?.branch_id && list.some(b => b.id === cfg.branch_id) ? cfg.branch_id : null;
        if (bound) setBranchId(bound);
        else if (list.length === 1) setBranchId(list[0].id);
        else setShowBranchPicker(true);   // first run, multiple branches — must pick once
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load branches');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const press = (d: string) => {
    setError('');
    setPin(p => (p.length >= PIN_MAX ? p : p + d));
  };
  const backspace = () => { setError(''); setPin(p => p.slice(0, -1)); };
  const clear = () => { setError(''); setPin(''); };

  const submit = async () => {
    if (!branchId) { setError('Select a branch first'); return; }
    if (pin.length < PIN_MIN) { setError(`PIN must be ${PIN_MIN}–${PIN_MAX} digits`); return; }
    setVerifying(true);
    setError('');
    try {
      const session = await posApi.auth.verifyPin(pin, branchId);
      const j = session.joinedDrawer;
      if (j && !j.sameCashier) {
        const id = await posApi.config.identity().catch(() => null);
        const till = id?.terminalCode ? `${id.terminalCode}${id.deviceName ? ` — ${id.deviceName}` : ''}` : (id?.deviceName || 'This till');
        const at = new Date(j.openedAt);
        const since = isNaN(at.getTime()) ? '' : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
        setJoined({ session, till, who: j.openedByName ?? 'another cashier', since });
        return;
      }
      onStaffLogin(session);
    } catch (e: any) {
      setError(e?.message ?? 'Invalid PIN');
      setPin('');
      setVerifying(false);
    }
  };

  // Allow the physical keyboard too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (verifying) return;
      if (e.key >= '0' && e.key <= '9') press(e.key);
      else if (e.key === 'Backspace') backspace();
      else if (e.key === 'Enter') submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bind each render so `submit` closes over current pin/branchId

  const selectedBranch = branches.find(b => b.id === branchId);
  const branchUnlicensed = selectedBranch && !selectedBranch.desktop_licensed;

  return (
    <div className="min-h-screen bg-[#080c14] flex flex-col items-center justify-center px-4">
      {/* 0.6.35 (A384): Help before anyone signs in — forgot the PIN, locked out, the till won't sync. Offline. */}
      {onHelp && (
        <button onClick={onHelp} data-testid="pin-help"
          className="fixed top-4 right-4 text-sm px-3 py-1.5 rounded-lg border border-gray-700 text-gray-200 hover:bg-gray-800 transition-colors">
          ? Help
        </button>
      )}
      {joined && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50">
          <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-6 w-full max-w-sm" data-testid="joined-drawer">
            <h2 className="text-lg font-bold text-white">{joined.till} is already open</h2>
            <p className="text-sm text-gray-300 mt-2">
              Opened by <span className="text-white font-semibold">{joined.who}</span>{joined.since ? ` at ${joined.since}` : ''} on the web POS.
              You will sell into the same drawer — every sale still records who rang it.
            </p>
            <button onClick={() => { const s = joined.session; setJoined(null); onStaffLogin(s); }}
              className="mt-5 w-full py-3 rounded-xl font-semibold text-sm bg-action-600 hover:bg-action-500 text-white">
              Continue
            </button>
          </div>
        </div>
      )}
      {techStage && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50" onClick={closeTech}>
          <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            {techStage === 'reveal' ? (
              <>
                <h2 className="text-lg font-bold text-white">Technician access</h2>
                <p className="text-xs text-gray-300 mt-1 mb-4">Enter the branch access code.</p>
                <input
                  autoFocus value={revealInput}
                  onChange={e => { setRevealInput(e.target.value.toUpperCase()); setTechErr(''); }}
                  onPaste={e => {
                    // D18: a tech often has only the token (admin Tech Access hands
                    // out the token, not a reveal code). Pasting it here would hit
                    // maxLength/upper-casing and truncate — "not allowing the full
                    // string". Detect a token and jump straight to the token step
                    // with the full value. The reveal code is a low-value doorknock;
                    // the token is branch-scoped and cryptographically verified.
                    const text = e.clipboardData.getData('text').trim();
                    if (text.startsWith('st2.')) {
                      e.preventDefault();
                      setTokenInput(text);
                      setTechErr('');
                      setTechStage('token');
                    }
                  }}
                  onKeyDown={e => e.key === 'Enter' && submitReveal()}
                  placeholder="ACCESS CODE" maxLength={12}
                  className="w-full bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-4 py-2.5 text-white text-center font-mono tracking-widest uppercase focus:outline-none focus:border-action-500"
                />
                {techErr && <p className="text-red-400 text-xs mt-2 text-center">{techErr}</p>}
                <div className="flex gap-2 mt-4">
                  <button onClick={closeTech} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] text-gray-300 rounded-lg py-2.5 text-sm">Cancel</button>
                  <button onClick={submitReveal} disabled={techBusy || revealInput.trim().length < 4}
                    className="flex-1 bg-action-500 hover:bg-action-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm">
                    {techBusy ? '…' : 'Continue'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-bold text-white">Technician token</h2>
                <p className="text-xs text-gray-300 mt-1 mb-4">Paste the access token issued for this branch.</p>
                <textarea
                  autoFocus value={tokenInput}
                  onChange={e => { setTokenInput(e.target.value); setTechErr(''); }}
                  placeholder="st2.…" rows={3}
                  className="w-full bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-3 py-2 text-white text-xs font-mono break-all focus:outline-none focus:border-action-500 resize-none"
                />
                {techErr && <p className="text-red-400 text-xs mt-2 text-center">{techErr}</p>}
                <div className="flex gap-2 mt-4">
                  <button onClick={() => { setTechStage('reveal'); setTechErr(''); }} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] text-gray-300 rounded-lg py-2.5 text-sm">Back</button>
                  <button onClick={submitToken} disabled={techBusy || tokenInput.trim().length < 10}
                    className="flex-1 bg-action-500 hover:bg-action-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm">
                    {techBusy ? 'Verifying…' : 'Unlock'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Fixed, centred lock card — same size on a till as on a wide monitor. */}
      <div
        className="rounded-2xl border border-[#1e293b] overflow-hidden grid"
        style={{ width: 720, maxWidth: '100%', height: 500, gridTemplateColumns: '1fr 1px 1.05fr', background: '#0d1424' }}
      >
        {/* ── LEFT: identity (centred both axes) ── */}
        <div className="flex flex-col items-center justify-center text-center px-8">
          {/* Logo (on a light card) or the business wordmark. Long-press here is
              the hidden technician entry (moved off the plain name text). */}
          <div
            className="select-none cursor-default"
            onPointerDown={startPress}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
          >
            {logoDataUri ? (
              // 0.6.25 (owner: "increase the size of the logo … the white space is big"): up to 160 × 240 on a tighter
              // card — as tall as the SwiftPOS default mark; was 88 × 220, which left a square logo small in its card.
              <span data-testid="pin-logo" className="inline-flex items-center justify-center bg-white rounded-xl" style={{ padding: '8px 10px' }}>
                <img src={logoDataUri} alt="" style={{ maxHeight: 160, maxWidth: 240, objectFit: 'contain', display: 'block' }} />
              </span>
            ) : (
              // No client logo -> the SwiftPOS default mark. Its wordmark is dark
              // (built for a light background), so it sits on the same white card
              // as client logos rather than on the dark surface.
              <span className="inline-flex items-center justify-center bg-white rounded-xl" style={{ padding: '18px 22px' }}>
                <img src={SWIFTPOS_LOGO} alt="ZapTill" style={{ height: 150, width: 'auto', maxWidth: 210, display: 'block' }} />
              </span>
            )}
          </div>

          <div className="text-xl font-bold mt-4" style={{ color: brand.accent }}>{businessName}</div>

          {/* Branch — bound to the device; a chip once bound, a picker on first run. */}
          <div className="mt-4 w-full max-w-[240px]">
            {loading ? (
              <div className="h-10 rounded-lg bg-[#0f172a] animate-pulse" />
            ) : branches.length === 0 ? (
              <p className="text-sm text-gray-300">No branches available.</p>
            ) : showBranchPicker || !selectedBranch ? (
              <select
                value={branchId ?? ''}
                onChange={e => { setBranchId(e.target.value || null); setError(''); setShowBranchPicker(false); }}
                className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-action-500"
              >
                <option value="">Select branch…</option>
                {branches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}{b.desktop_licensed ? '' : ' (no desktop licence)'}
                  </option>
                ))}
              </select>
            ) : (
              <div className="inline-flex items-center gap-2 bg-[#0f172a] border border-[#1e293b] rounded-lg px-4 py-2 text-sm text-gray-400">
                Branch: <span className="text-gray-200">{selectedBranch.name}</span>
              </div>
            )}
          </div>

          {branchUnlicensed && (
            <p className="mt-3 text-amber-400 text-xs bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2 max-w-[240px]">
              This branch has no desktop licence. Contact ZapTill to activate it.
            </p>
          )}

          <div className="mt-6 text-[11px] text-gray-500 flex items-center gap-1.5">
            <span>🔒</span> powered by <b className="text-gray-400 font-semibold">ZapTill</b>
          </div>
        </div>

        {/* ── divider (accent) ── */}
        <div style={{ background: `linear-gradient(to bottom, transparent, ${brand.accent} 18%, ${brand.accent} 82%, transparent)`, opacity: 0.55 }} />

        {/* ── RIGHT: keypad ── */}
        <div className="flex flex-col justify-center px-10">
          <div className="w-full max-w-[300px] mx-auto">
            <p className="text-gray-300 text-sm text-center">Enter your PIN</p>
            <p className="text-gray-500 text-xs mb-4 text-center">to start a shift</p>

            {/* PIN dots */}
            <div className="flex gap-3 mb-5 justify-center">
              {Array.from({ length: PIN_MAX }).map((_, i) => (
                <span
                  key={i}
                  className={`w-3.5 h-3.5 rounded-full border ${i < pin.length ? '' : 'border-gray-600'}`}
                  style={i < pin.length ? { backgroundColor: brand.accent, borderColor: brand.accent } : undefined}
                />
              ))}
            </div>

            {error && (
              <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5 text-center mb-4">
                {error}
              </p>
            )}

            {/* Keypad */}
            <div className="grid grid-cols-3 gap-2.5">
              {['1','2','3','4','5','6','7','8','9'].map(d => (
                <button
                  key={d}
                  onClick={() => press(d)}
                  disabled={verifying}
                  className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-white text-lg font-semibold disabled:opacity-40 focus:outline-none flex items-center justify-center"
                  style={{ aspectRatio: '1.6' }}
                >
                  {d}
                </button>
              ))}
              <button
                onClick={clear}
                disabled={verifying}
                className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-gray-400 text-sm disabled:opacity-40 focus:outline-none flex items-center justify-center"
                style={{ aspectRatio: '1.6' }}
              >
                Clear
              </button>
              <button
                onClick={() => press('0')}
                disabled={verifying}
                className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-white text-lg font-semibold disabled:opacity-40 focus:outline-none flex items-center justify-center"
                style={{ aspectRatio: '1.6' }}
              >
                0
              </button>
              <button
                onClick={backspace}
                disabled={verifying}
                className="rounded-xl bg-[#0f172a] hover:bg-gray-700 text-gray-400 text-lg disabled:opacity-40 focus:outline-none flex items-center justify-center"
                style={{ aspectRatio: '1.6' }}
              >
                ⌫
              </button>
            </div>

            <button
              onClick={submit}
              disabled={verifying || !branchId || pin.length < PIN_MIN}
              style={{ backgroundColor: brand.accent, color: brand.buttonText }}
              className="w-full disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none font-bold rounded-xl py-3 mt-3.5 transition-[filter] hover:brightness-110"
            >
              {verifying ? 'Verifying…' : 'Enter'}
            </button>
          </div>
        </div>
      </div>

      {/* Signing out the OWNER is not a cashier's action — restoring it needs
          the owner's email and password, which nobody on the floor has at
          07:00. It lives on the manager screen instead.

          The exception is when this screen cannot function: no branches
          loaded, or the session failed outright. Hiding it unconditionally
          would mean a till whose refresh token has died is bricked, with no
          route to sign in again. So it appears only as a way out of a screen
          that is already broken. */}
      {(error || branches.length === 0) && !loading && (
        confirmSignOut ? (
          <div className="mt-6 border border-gray-800 rounded-xl p-3 w-full max-w-sm">
            <p className="text-xs text-gray-200 text-center">
              Sign this till out of the business?
            </p>
            <p className="text-xs text-gray-400 text-center mt-1">
              Getting back in needs the owner's email and password. Staff PINs will
              not work until then.
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setConfirmSignOut(false)}
                className="flex-1 py-2 rounded-lg text-xs border border-gray-700 text-gray-200 hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onBackToOwner}
                className="flex-1 py-2 rounded-lg text-xs bg-red-600 hover:bg-red-500 text-white transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmSignOut(true)}
            className="text-center text-gray-400 hover:text-white text-xs mt-6"
          >
            Sign out / switch account
          </button>
        )
      )}
    </div>
  );
}
