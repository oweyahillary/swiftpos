import { useEffect, useState } from 'react';
import { posApi, StaffSession } from '../lib/posApi';

interface Branch { id: string; name: string; desktop_licensed: boolean; }

interface Props {
  businessName: string;
  onStaffLogin: (s: StaffSession) => void;
  onBackToOwner: () => void;   // full sign-out (switch business / owner)
}

const PIN_MAX = 6;
const PIN_MIN = 4;

export default function PinPage({ businessName, onStaffLogin, onBackToOwner }: Props) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
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
          <h1 className="text-2xl font-bold text-green-400">{businessName}</h1>
          <p className="text-gray-500 text-sm mt-1">Enter your PIN to start a shift</p>
        </div>

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
