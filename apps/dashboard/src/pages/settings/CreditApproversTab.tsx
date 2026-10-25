import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { usePermissions } from '../../context/PermissionsContext';
import { approvalSummary, staffForBranch, toggleApprover, type ApprovalRule, type ApproversView } from '../../lib/creditApprovers';

// Settings › Business › Credit approvals — A585 (owner, 2026-10-23: "credit limit — the owner for now; they can assign to
// branch manager for approval but they set the limit"). The owner turns approval on and picks, per branch, who may
// approve a sale on account (at the till with their PIN, or themselves when they sell). Off = today's rule. The owner
// alone sets every customer's limit; no approver can sell past it. GET / PUT /api/credit/approvers (the owner only).

export function CreditApproversView({ view, rule, onChange, onSave, saving, saved, error }: {
  view: ApproversView; rule: ApprovalRule; onChange: (r: ApprovalRule) => void; onSave: () => void;
  saving: boolean; saved: boolean; error: string;
}) {
  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl" data-testid="credit-approvers">
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-semibold">Who approves credit sales</h2>
            <p className="text-sm text-gray-400 mt-1">{approvalSummary(rule)}</p>
            <p className="text-xs text-gray-500 mt-2">You set every customer's credit limit yourself (Customers › a customer). Approvers say yes to a sale on account — they never change a limit.</p>
          </div>
          <button type="button" role="switch" aria-checked={rule.on} aria-label="Approval of credit sales" data-testid="credit-approval-switch"
            onClick={() => onChange({ ...rule, on: !rule.on })}
            className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${rule.on ? 'bg-swift-strong' : 'bg-gray-700'}`}>
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${rule.on ? 'left-5' : 'left-1'}`} />
          </button>
        </div>
      </div>
      {rule.on && view.branches.map((b) => {
        const people = staffForBranch(view.staff, b.id);
        const picked = rule.branches[b.id] ?? [];
        return (
          <div key={b.id} className="rounded-xl border border-gray-800 bg-gray-900 p-4" data-testid={`approvers-${b.id}`}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-white font-medium">{b.name || 'Branch'}</p>
              <p className="text-xs text-gray-500">{picked.length ? `${picked.length} chosen` : 'Only you'}</p>
            </div>
            {people.length === 0 && <p className="text-sm text-gray-500">Nobody works at this branch yet.</p>}
            <div className="grid sm:grid-cols-2 gap-1.5">
              {people.map((s) => (
                <label key={s.id} className="flex items-center gap-2 rounded-lg bg-gray-800/60 px-3 py-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={picked.includes(s.id)} onChange={() => onChange(toggleApprover(rule, b.id, s.id))} />
                  <span className="text-white">{s.name || 'Staff'}</span>
                  {s.role && <span className="text-gray-500 text-xs">· {s.role}</span>}
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        <button onClick={onSave} disabled={saving} data-testid="credit-approvers-save"
          className="px-4 py-2 bg-swift hover:bg-swift-light disabled:opacity-40 text-gray-950 text-sm font-bold rounded-lg">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-gray-300">Saved. The points of sale take it with their next customer list (within a minute online).</span>}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  );
}

export default function CreditApproversTab() {
  const { isOwner } = usePermissions();
  const [view, setView] = useState<ApproversView | null>(null);
  const [rule, setRule] = useState<ApprovalRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOwner) return;
    api.get<ApproversView>('/api/credit/approvers')
      .then((v) => { setView(v); setRule(v.rule); })
      .catch((e) => setError(e?.message ?? 'Could not load the setting'));
  }, [isOwner]);

  if (!isOwner) return <div className="p-4 sm:p-6 text-gray-500 text-sm">Only the owner chooses who approves credit sales.</div>;
  if (!view || !rule) return <div className="p-4 sm:p-6 text-gray-500 text-sm">{error || 'Loading…'}</div>;

  const save = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      const r = await api.put<{ rule: ApprovalRule }>('/api/credit/approvers', rule);
      setRule(r.rule); setSaved(true); setTimeout(() => setSaved(false), 4000);
    } catch (e: any) { setError(e?.message ?? 'Could not save'); }
    finally { setSaving(false); }
  };
  return <CreditApproversView view={view} rule={rule} onChange={setRule} onSave={save} saving={saving} saved={saved} error={error} />;
}
