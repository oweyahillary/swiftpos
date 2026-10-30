/**
 * POSPage.tsx — /dashboard/pos, "Open POS" in the dashboard menu.
 *
 * A608 (owner, 2026-10-29: managers sell on the web POS — "is there a reason of two sign ins?" — no): someone signed in to
 * the web dashboard opens the web POS as themselves, with no PIN. Their dashboard session is exchanged for a web POS
 * session at the branch in view (POST /api/auth/pos-session — the cloud checks they may sell there); with several
 * branches and none in view, they pick one. A POS this tab already opened for that branch is opened again as it is.
 * Cashiers sign in on /pos with their PIN, as before. The menu entry is shown only to people who may sell (orders.create,
 * DashboardLayout NAV_KEYS).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import { useBusiness } from '../../context/BusinessContext';
import { storeCashierSession, dashboardPosSession, type BusinessMode } from '../../context/POSAuthContext';
import { getDeviceHint } from '../../lib/deviceFingerprint';

interface PosBranch { id: string; name: string }
interface PosSessionAnswer {
  accessToken?: string; refreshToken?: string; token?: string;
  staff: { id: string; name: string; role: string | null };
  permissions?: Record<string, boolean>;
  branchId: string | null;
  branches: PosBranch[];
  needsBranchSelection: boolean;
}

export default function POSPage() {
  const navigate = useNavigate();
  const { activeBranchId } = useBranch();
  const { business } = useBusiness();
  const [choices, setChoices] = useState<PosBranch[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async (branchId: string | null) => {
    const held = dashboardPosSession(branchId);
    if (held) { navigate('/pos/cashier'); return; }
    setBusy(true); setError('');
    try {
      const r = await api.post<PosSessionAnswer>('/api/auth/pos-session', { ...(branchId ? { branch_id: branchId } : {}), device_hint: await getDeviceHint() });
      if (r.needsBranchSelection || !r.branchId) { setChoices(r.branches ?? []); return; }
      if (dashboardPosSession(r.branchId)) { navigate('/pos/cashier'); return; }
      storeCashierSession({
        token:         r.accessToken ?? r.token ?? '',
        refreshToken:  r.refreshToken ?? '',
        staffId:       r.staff.id,
        staffName:     r.staff.name,
        role:          r.staff.role ?? '',
        branchId:      r.branchId,
        branchName:    r.branches.find((b) => b.id === r.branchId)?.name ?? '',
        businessType:  ((business?.type as BusinessMode) ?? 'retail'),
        currency:      business?.currency ?? 'KES',
        permissions:   r.permissions ?? {},
        fromDashboard: true,
      });
      navigate('/pos/cashier');
    } catch (e: any) {
      setError(e?.message ?? 'Could not open the POS');
    } finally { setBusy(false); }
  };

  // The branch in view ("All branches" — none: the cloud says which, or asks).
  useEffect(() => { void open(activeBranchId); }, [activeBranchId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-md mx-auto p-6 space-y-4" data-testid="open-pos">
      <h1 className="text-xl font-bold text-white">Open POS</h1>
      {busy && <p className="text-sm text-gray-400">Opening the POS…</p>}
      {error && (
        <div className="space-y-2">
          <p className="text-sm text-red-400" data-testid="open-pos-error">{error}</p>
          <Link to="/dashboard" className="text-sm text-gray-400 underline">Back to the dashboard</Link>
        </div>
      )}
      {choices && !busy && (
        <div className="space-y-2">
          <p className="text-sm text-gray-400">Which branch are you selling at?</p>
          {choices.map((b) => (
            <button key={b.id} type="button" onClick={() => void open(b.id)} data-testid="open-pos-branch"
              className="w-full text-left bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white">
              {b.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
