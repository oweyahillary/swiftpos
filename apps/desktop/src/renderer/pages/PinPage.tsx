import { useEffect, useState, useRef } from 'react';
import { posApi, StaffSession } from '../lib/posApi';

interface Branch { id: string; name: string; desktop_licensed: boolean; }

interface Props {
  businessName: string;
  onStaffLogin: (s: StaffSession) => void;
  onBackToOwner: () => void;   // full sign-out (switch business / owner)
  onTechUnlock: () => void;    // hidden: long-press logo -> reveal code -> token
}

const PIN_MAX = 6;
const PIN_MIN = 4;

export default function PinPage({ businessName, onStaffLogin, onBackToOwner, onTechUnlock }: Props) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

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
  // device), so the PIN pad doesn't ask again. "change" reveals the selector.
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
    <div className="min-h-screen bg-[#080c14] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1
            className="text-2xl font-bold text-green-400 select-none cursor-default"
            onPointerDown={startPress}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            title=""
          >{businessName}</h1>
          <p className="text-gray-500 text-sm mt-1">Enter your PIN to start a shift</p>
        </div>

        {techStage && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50" onClick={closeTech}>
            <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
              {techStage === 'reveal' ? (
                <>
                  <h2 className="text-lg font-bold text-white">Technician access</h2>
                  <p className="text-xs text-gray-500 mt-1 mb-4">Enter the branch access code.</p>
                  <input
                    autoFocus value={revealInput}
                    onChange={e => { setRevealInput(e.target.value.toUpperCase()); setTechErr(''); }}
                    onKeyDown={e => e.key === 'Enter' && submitReveal()}
                    placeholder="ACCESS CODE" maxLength={12}
                    className="w-full bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-4 py-2.5 text-white text-center font-mono tracking-widest uppercase focus:outline-none focus:border-green-500"
                  />
                  {techErr && <p className="text-red-400 text-xs mt-2 text-center">{techErr}</p>}
                  <div className="flex gap-2 mt-4">
                    <button onClick={closeTech} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] text-gray-300 rounded-lg py-2.5 text-sm">Cancel</button>
                    <button onClick={submitReveal} disabled={techBusy || revealInput.trim().length < 4}
                      className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm">
                      {techBusy ? '…' : 'Continue'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-bold text-white">Technician token</h2>
                  <p className="text-xs text-gray-500 mt-1 mb-4">Paste the access token issued for this branch.</p>
                  <textarea
                    autoFocus value={tokenInput}
                    onChange={e => { setTokenInput(e.target.value); setTechErr(''); }}
                    placeholder="st2.…" rows={3}
                    className="w-full bg-[#0a0f1a] border border-[#1e293b] rounded-lg px-3 py-2 text-white text-xs font-mono break-all focus:outline-none focus:border-green-500 resize-none"
                  />
                  {techErr && <p className="text-red-400 text-xs mt-2 text-center">{techErr}</p>}
                  <div className="flex gap-2 mt-4">
                    <button onClick={() => { setTechStage('reveal'); setTechErr(''); }} className="flex-1 bg-[#1e293b] hover:bg-[#26344b] text-gray-300 rounded-lg py-2.5 text-sm">Back</button>
                    <button onClick={submitToken} disabled={techBusy || tokenInput.trim().length < 10}
                      className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-40 text-gray-950 font-semibold rounded-lg py-2.5 text-sm">
                      {techBusy ? 'Verifying…' : 'Unlock'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="bg-[#0d1424] border border-[#1e293b] rounded-2xl p-6 space-y-4">
          {/* Branch — bound to the device; shown as a chip unless changing */}
          <div>
            {loading ? (
              <div className="h-10 rounded-lg bg-[#0f172a] animate-pulse" />
            ) : branches.length === 0 ? (
              <p className="text-sm text-gray-500">No branches available.</p>
            ) : showBranchPicker || !selectedBranch ? (
              <>
                <label className="block text-sm text-gray-400 mb-1.5">Branch</label>
                <select
                  value={branchId ?? ''}
                  onChange={e => { setBranchId(e.target.value || null); setError(''); setShowBranchPicker(false); }}
                  className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-green-500"
                >
                  <option value="">Select branch…</option>
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.desktop_licensed ? '' : ' (no desktop licence)'}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <div className="flex items-center justify-between bg-[#0f172a] border border-[#1e293b] rounded-lg px-4 py-2">
                <span className="text-sm text-gray-300">
                  <span className="text-gray-500">Branch:</span> {selectedBranch.name}
                </span>
                {branches.length > 1 && (
                  <button
                    onClick={() => setShowBranchPicker(true)}
                    className="text-xs text-gray-500 hover:text-green-400 transition-colors"
                  >
                    change
                  </button>
                )}
              </div>
            )}
          </div>

          {branchUnlicensed && (
            <p className="text-amber-400 text-xs bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">
              This branch has no desktop licence. Contact SwiftPOS to activate it.
            </p>
          )}

          {/* PIN dots */}
          <div className="flex justify-center gap-3 py-2">
            {Array.from({ length: PIN_MAX }).map((_, i) => (
              <span
                key={i}
                className={`w-3.5 h-3.5 rounded-full border ${
                  i < pin.length ? 'bg-green-400 border-green-400' : 'border-gray-600'
                }`}
              />
            ))}
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-2.5 text-center">
              {error}
            </p>
          )}

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-2">
            {['1','2','3','4','5','6','7','8','9'].map(d => (
              <button
                key={d}
                onClick={() => press(d)}
                disabled={verifying}
                className="py-4 rounded-xl bg-[#0f172a] hover:bg-gray-700 text-white text-xl font-semibold disabled:opacity-40"
              >
                {d}
              </button>
            ))}
            <button
              onClick={clear}
              disabled={verifying}
              className="py-4 rounded-xl bg-[#0f172a] hover:bg-gray-700 text-gray-400 text-sm disabled:opacity-40"
            >
              Clear
            </button>
            <button
              onClick={() => press('0')}
              disabled={verifying}
              className="py-4 rounded-xl bg-[#0f172a] hover:bg-gray-700 text-white text-xl font-semibold disabled:opacity-40"
            >
              0
            </button>
            <button
              onClick={backspace}
              disabled={verifying}
              className="py-4 rounded-xl bg-[#0f172a] hover:bg-gray-700 text-gray-400 text-xl disabled:opacity-40"
            >
              ⌫
            </button>
          </div>

          <button
            onClick={submit}
            disabled={verifying || !branchId || pin.length < PIN_MIN}
            className="w-full bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 font-bold rounded-xl py-3 transition-colors"
          >
            {verifying ? 'Verifying…' : 'Enter'}
          </button>
        </div>

        <button
          onClick={onBackToOwner}
          className="w-full text-center text-gray-600 hover:text-gray-400 text-xs mt-6"
        >
          Sign out / switch account
        </button>
      </div>
    </div>
  );
}
