import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import Pager, { usePageSize } from '../../components/Pager';   // A475
import { paginate } from '../../lib/paginate';
import { expandKeys, isBackOffice, OPEN_BEFORE_A490 } from '../../lib/permissions';   // A490
import PermissionPicker, { usePermissionCatalogue, keyDifferences, type CatalogueKey, type CatalogueGroup } from '../../components/PermissionPicker';

interface Branch { id: string; name: string; }
/** A490: a role as GET /api/staff/roles answers it — its FINE keys, whether it is the owner's, whether this user may give it. */
interface Role {
  id: string; name: string;
  keys?: string[];
  is_owner_role?: boolean;
  assignable?: boolean;
}
interface StaffMember {
  id: string; name: string; email: string | null; phone: string | null; status: string;
  hourly_rate: number | null;
  roles: { id: string; name: string } | null;
  user_branches: { branch_id: string; branches: { id: string; name: string } }[];
  user_permissions?: { permission_id: string; granted: boolean }[];
  /** A490: the person's own rights — a key given (true) or taken away (false) on top of their role's. */
  override_keys?: Record<string, boolean> | null;
}

interface Props {
  branches: Branch[];
  /** A391: the owner may reset a back-office person's sign-in code (lost phone → emailed codes). */
  canResetSignIn?: boolean;
  /** A490: add, edit, deactivate — staff.edit (the manager portal passes it; the owner always may). */
  canEdit?: boolean;
  /** A550: the owner gives, re-sends and takes away web dashboard access (partner login) — the owner's dashboard only. */
  webAccess?: boolean;
}

/** A550: GET /api/staff/web-access — each person's web dashboard access. */
type WebAccessState = { status: 'invited' | 'active' | 'revoked'; granted_at: string; activated_at: string | null; revoked_at: string | null };
const WEB_STATUS: Record<WebAccessState['status'], { label: string; cls: string }> = {
  invited: { label: 'Web: invited',  cls: 'bg-amber-500/15 text-amber-300' },
  active:  { label: 'Web: active',   cls: 'bg-swift/15 text-swift-text' },
  revoked: { label: 'Web: revoked',  cls: 'bg-gray-700 text-gray-400' },
};

/** A490: a role's keys as a set ('*' for the owner's role). */
export function roleKeySet(role: Role | undefined): Set<string> {
  if (!role) return new Set();
  if (role.is_owner_role) return new Set(['*']);
  return expandKeys(role.keys ?? []);
}

/** A490: the keys a person holds — their role's, with their own overrides applied. */
export function personKeys(role: Role | undefined, overrides: Record<string, boolean> | null | undefined): Set<string> {
  const held = roleKeySet(role);
  if (held.has('*')) return held;
  for (const [k, on] of Object.entries(overrides ?? {})) { if (on === true) held.add(k); else if (on === false) held.delete(k); }
  return held;
}

/** A490: back office (sign-in codes apply, the reset is offered) — by the keys they hold, never by the role's name.
 *  The keys every role was given by migration 134 (OPEN_BEFORE_A490: staff.view, sales.history_all, …) do not count,
 *  as in lib/posRouting.ts — they would make every cashier "back office". */
export function needsSignInCode(role: Role | undefined, overrides: Record<string, boolean> | null | undefined): boolean {
  const held = personKeys(role, overrides);
  for (const k of OPEN_BEFORE_A490) held.delete(k);
  return isBackOffice(held);
}

const STATUS_COLORS: Record<string, string> = {
  active:   'bg-green-500/15 text-green-400',
  inactive: 'bg-gray-700 text-gray-500',
};

export default function StaffTab({ branches, canResetSignIn, canEdit = true, webAccess = false }: Props) {
  const { activeBranchId } = useBranch();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);        // the roles this user may give (assignable)
  const [allRoles, setAllRoles] = useState<Role[]>([]);  // every role — to read a person's keys
  const catalogue = usePermissionCatalogue(api);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');   // A506: a refused load / deactivate / activate is said
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [mode, setMode] = useState<'pin' | 'invite'>('pin');
  const [page, setPage] = useState(1);   // A475
  const [pageSize, setPageSize] = usePageSize('swiftpos.pageSize.staff');
  const [web, setWeb] = useState<Record<string, WebAccessState>>({});   // A550
  const [webNote, setWebNote] = useState('');

  const fetchAll = async () => {
    try {
      const [staffData, rolesData, webData] = await Promise.all([
        api.get<StaffMember[]>(activeBranchId ? `/api/staff?branch_id=${activeBranchId}` : '/api/staff'),
        api.get<Role[]>('/api/staff/roles'),
        webAccess ? api.get<Record<string, WebAccessState>>('/api/staff/web-access').catch(() => ({})) : Promise.resolve({}),
      ]);
      setWeb(webData ?? {});
      setStaff(staffData ?? []);
      // A340 / A490: the cloud marks the roles THIS user may hand out (`assignable` — never a role with more than they
      // hold, never the owner's). No role names are listed here any more.
      setAllRoles(rolesData ?? []);
      setRoles((rolesData ?? []).filter(r => r.assignable !== false && !r.is_owner_role));
      setListError('');
    } catch (err: any) { console.error(err); setListError(err?.message ?? 'Could not load the staff'); }   // A506
    finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, [activeBranchId]);

  const deactivate = async (id: string) => {
    showConfirm({
      title: 'Deactivate staff member?',
      message: 'They will lose access immediately. You can reactivate them later.',
      intent: 'warning',
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        // A506: the cloud refuses some (A494: a peer, someone holding more, another branch) — say so.
        try { await api.delete(`/api/staff/${id}`); fetchAll(); }
        catch (e: any) { setListError(e?.message ?? 'Could not deactivate'); }
      },
    });
  };

  const resetSignIn = (s: StaffMember) => {
    showConfirm({
      title: `Reset ${s.name}'s sign-in code?`,
      message: 'They will get their sign-in code by email next time, instead of from an authenticator app (use this for a lost phone).',
      intent: 'warning',
      confirmLabel: 'Reset',
      onConfirm: async () => {
        try { await api.post(`/api/staff/${s.id}/reset-otp`, {}); }
        catch (e: any) { setListError(e?.message ?? 'Could not reset the sign-in code'); }   // A506
      },
    });
  };

  // A550: web dashboard access — they sign in at this business's address with their email and a password they set.
  const giveWeb = (s: StaffMember, again: boolean) => {
    showConfirm({
      title: again ? `Send ${s.name} the invitation again?` : `Give ${s.name} web dashboard access?`,
      message: again
        ? `A new invitation goes to ${s.email}.`
        : `${s.name} will sign in to this dashboard with ${s.email} and a password they set (the invitation says how), plus a one-time code each time. They see and do only what their role allows — never what is yours alone.`,
      intent: 'warning',
      confirmLabel: again ? 'Send again' : 'Give access',
      onConfirm: async () => {
        setWebNote(''); setListError('');
        try {
          const r = await api.post<{ emailed?: boolean; warning?: string }>(`/api/staff/${s.id}/web-access`, {});
          setWebNote(r?.warning ?? `Invitation sent to ${s.email}.`);
          fetchAll();
        } catch (e: any) { setListError(e?.message ?? 'Could not give web dashboard access'); }
      },
    });
  };
  const revokeWeb = (s: StaffMember) => {
    showConfirm({
      title: `Take away ${s.name}'s web dashboard access?`,
      message: 'They are signed out of the dashboard everywhere at once. Their PIN on the tills is not changed.',
      intent: 'warning',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        setWebNote(''); setListError('');
        try { await api.delete(`/api/staff/${s.id}/web-access`); setWebNote(`${s.name} no longer has web dashboard access.`); fetchAll(); }
        catch (e: any) { setListError(e?.message ?? 'Could not revoke web dashboard access'); }
      },
    });
  };

  const activate = async (id: string) => {
    try { await api.patch(`/api/staff/${id}`, { status: 'active' }); fetchAll(); }
    catch (e: any) { setListError(e?.message ?? 'Could not activate'); }   // A506
  };

  // A475: the staff in pages (25 / 50 / 100, remembered in this browser); the active count is over everyone. Another
  // branch → page 1; an edit, deactivate or activate keeps the page (clamped).
  useEffect(() => { setPage(1); }, [activeBranchId]);
  const paged = paginate(staff, page, pageSize);
  useEffect(() => { if (paged.page !== page) setPage(paged.page); }, [paged.page, page]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-white font-semibold text-lg">Staff Members</h2>
          <p className="text-gray-500 text-sm">{staff.filter(s => s.status === 'active').length} active</p>
        </div>
        {canEdit && (
        <button onClick={() => { setEditing(null); setShowModal(true); }}
          className="px-4 py-2 bg-swift hover:bg-swift-light text-gray-950 text-sm font-semibold rounded-xl transition-colors">
          + Add Staff
        </button>
        )}
      </div>

      {listError && <p className="text-sm text-red-400" data-testid="staff-error">{listError}</p>}
      {webNote && <p className="text-sm text-gray-300" data-testid="web-access-note">{webNote}</p>}
      {loading ? (
        <div className="text-gray-500 text-sm py-10 text-center">Loading…</div>
      ) : staff.length === 0 ? (
        <div className="text-gray-600 text-sm py-10 text-center">No staff members yet</div>
      ) : (
        <div className="space-y-2">
          {paged.items.map(s => {
            const branchNames = s.user_branches?.map(b => b.branches?.name).filter(Boolean) ?? [];
            const overrideCount = s.override_keys ? Object.keys(s.override_keys).length : (s.user_permissions?.length ?? 0);
            const role = allRoles.find(r => r.id === s.roles?.id);
            return (
              <div key={s.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-gray-700 flex items-center justify-center text-white font-semibold text-sm">
                    {s.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white text-sm font-medium">{s.name}</span>
                      {s.roles && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 font-medium capitalize">
                          {s.roles.name}
                        </span>
                      )}
                      {overrideCount > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300">
                          {overrideCount} custom right{overrideCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[s.status] ?? 'bg-gray-700 text-gray-500'}`}>
                        {s.status}
                      </span>
                      {webAccess && web[s.id] && (
                        <span data-testid="web-access-status" className={`text-xs px-2 py-0.5 rounded-full font-medium ${WEB_STATUS[web[s.id].status]?.cls ?? ''}`}>
                          {WEB_STATUS[web[s.id].status]?.label ?? web[s.id].status}
                        </span>
                      )}
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {s.email ?? s.phone ?? 'PIN only'} · {branchNames.length ? branchNames.join(', ') : 'All branches'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* A550: web dashboard access — the owner's; never for the owner's own role, someone inactive or without email */}
                  {webAccess && s.status === 'active' && s.email && !role?.is_owner_role && (() => {
                    const w = web[s.id];
                    const live = w && w.status !== 'revoked';
                    return (
                      <>
                        <button onClick={() => giveWeb(s, !!live)} data-testid={live ? 'web-access-resend' : 'web-access-give'}
                          className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors">
                          {live ? 'Resend invite' : 'Give web access'}
                        </button>
                        {live && (
                          <button onClick={() => revokeWeb(s)} data-testid="web-access-revoke"
                            className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors">
                            Revoke web access
                          </button>
                        )}
                      </>
                    );
                  })()}
                  {canResetSignIn && s.status === 'active' && needsSignInCode(role, s.override_keys) && (
                    <button onClick={() => resetSignIn(s)} data-testid="reset-signin"
                      className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors">
                      Reset sign-in code
                    </button>
                  )}
                  {canEdit && <button onClick={() => { setEditing(s); setShowModal(true); }}
                    className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors">
                    Edit
                  </button>}
                  {!canEdit ? null : s.status === 'active' ? (
                    <button onClick={() => deactivate(s.id)}
                      className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors">
                      Deactivate
                    </button>
                  ) : (
                    <button onClick={() => activate(s.id)}
                      className="text-xs text-swift-text hover:text-swift-text-hover px-3 py-1.5 rounded-lg hover:bg-swift/10 transition-colors">
                      Activate
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <Pager paged={paged} noun="staff" onPage={setPage} onSize={n => { setPageSize(n); setPage(1); }} />
        </div>
      )}

      {showModal && (
        <StaffModal
          editing={editing}
          roles={roles}
          allRoles={allRoles}
          catalogue={catalogue}
          branches={branches}
          mode={mode}
          setMode={setMode}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); fetchAll(); }}
        />
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}

/** A506: the same branches, in any order. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const A = new Set(a.filter(Boolean)), B = new Set(b.filter(Boolean));
  return A.size === B.size && [...A].every((x) => B.has(x));
}

/** A506: the same own rights (a key given or taken away) — nothing set and {} are the same. */
export function sameOverrides(a: Record<string, boolean> | null | undefined, b: Record<string, boolean> | null | undefined): boolean {
  const ea = Object.entries(a ?? {}), eb = b ?? {};
  return ea.length === Object.keys(eb).length && ea.every(([k, v]) => eb[k] === v);
}

// ── Staff Modal ───────────────────────────────────────────────────────────────
interface ModalProps {
  editing: StaffMember | null;
  roles: Role[];
  allRoles: Role[];
  catalogue: { keys: CatalogueKey[]; groups: CatalogueGroup[] };
  branches: Branch[];
  mode: 'pin' | 'invite';
  setMode: (m: 'pin' | 'invite') => void;
  onClose: () => void;
  onSaved: () => void;
}

// A423: an email followed by password-type PINs reads to the browser as a sign-in form, and it filled in the OWNER's
// saved email and password. Every email here is autoComplete="off" and every PIN "new-password" — the form starts empty.
function StaffModal({ editing, roles, allRoles, catalogue, branches, mode, setMode, onClose, onSaved }: ModalProps) {
  const [hourlyRate, setHourlyRate] = useState(editing?.hourly_rate != null ? String(editing.hourly_rate) : '');
  const [name, setName] = useState(editing?.name ?? '');
  const [email, setEmail] = useState(editing?.email ?? '');
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [roleId, setRoleId] = useState(editing?.roles?.id ?? roles[0]?.id ?? '');
  const [pin, setPin] = useState('');
  const [overridePin, setOverridePin] = useState('');
  const [clearOverride, setClearOverride] = useState(false);
  const [selectedBranches, setSelectedBranches] = useState<string[]>(
    editing?.user_branches?.map(b => b.branch_id) ??
    (branches.length > 0 ? [branches[0].id] : [])  // default to first branch (main) for new staff
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showBranchDropdown) return;
    const handler = () => setShowBranchDropdown(false);
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBranchDropdown]);

  // A490: the person's rights by KEY — pre-filled from the role's keys, with their own overrides applied. What differs
  // from the role is saved as override_keys ({ key: true } given, { key: false } taken away).
  const roleById = (rid: string) => allRoles.find(r => r.id === rid) ?? roles.find(r => r.id === rid);
  const [effectiveKeys, setEffectiveKeys] = useState<Set<string>>(() => personKeys(roleById(roleId), editing?.override_keys));
  const roleBaseline = roleKeySet(roleById(roleId));
  const allKeys = catalogue.keys.map(k => k.key);
  const diff = keyDifferences(effectiveKeys, roleBaseline, allKeys);
  const diffCount = diff.added.length + diff.removed.length;
  // A506: an override PIN approves voids and refunds — only for someone who will hold sales.void or sales.refund.
  // A514: the business supervisor PIN is retired — this per-person APPROVAL PIN is how the owner or a manager makes
  // someone an approver: of voids, refunds, sales on account (customers.credit) or drawers / cash out (shifts.confirm).
  // The cloud's rule is the same list (routes/staff.ts APPROVAL_PIN_KEYS). A518: an approver's SIGN-IN PIN approves as it
  // is; this approval PIN is optional — a second PIN for someone who would rather not type their sign-in PIN in front of
  // cashiers.
  const mayApprove = effectiveKeys.has('*') || ['sales.void', 'sales.refund', 'customers.credit', 'shifts.confirm'].some(k => effectiveKeys.has(k));

  // When the role changes, start again from the new role's keys.
  const handleRoleChange = (newRoleId: string) => {
    setRoleId(newRoleId);
    setEffectiveKeys(roleKeySet(roleById(newRoleId)));
  };

  const toggleBranch = (id: string) =>
    setSelectedBranches(prev => prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!roleId) { setError('Role is required'); return; }
    if (!editing && mode === 'pin' && !pin) { setError('PIN is required'); return; }
    if (!editing && mode === 'invite' && !email) { setError('Email is required'); return; }

    // A490: what differs from the role, by key.
    const override_keys: Record<string, boolean> = {};
    if (!roleBaseline.has('*')) {
      for (const k of diff.added) override_keys[k] = true;
      for (const k of diff.removed) override_keys[k] = false;
    }

    // Override (approval) PIN payload: '' clears (revoke), a value sets/replaces, omit = keep. A506/A514: only for someone
    // who will be able to approve (the cloud refuses it otherwise — OVERRIDE_PIN_NO_AUTHORITY).
    const overrideField: { override_pin?: string } =
      clearOverride ? { override_pin: '' }
      : overridePin && mayApprove ? { override_pin: overridePin }
      : {};

    // A494: an empty branch list is left out, never sent as [] — the cloud refuses [] from a manager (it used to mean
    // "every branch"); left out, an edit keeps the person's branches and a new person gets the manager's own branch.
    // A506: an EDIT sends what changed and nothing else. The cloud reads a field sent as a change: role_id or
    // override_keys sent unchanged made a manager's edit of their own name "You cannot change your own role, permissions
    // or branches" (OWN_ACCESS); an unchanged e-mail made an edit of a peer's name PEER_CREDENTIALS; an unchanged branch
    // list naming a second branch was "You can only assign staff to your own branch". The owner clearing every branch
    // ("All branches") still sends [] — it is a change.
    const branchField: { branch_ids?: string[] } = editing
      ? (sameSet(selectedBranches, editing.user_branches?.map(b => b.branch_id) ?? []) ? {} : { branch_ids: selectedBranches })
      : selectedBranches.length ? { branch_ids: selectedBranches } : {};
    const keysChanged = !editing || !sameOverrides(override_keys, editing.override_keys);
    const roleChanged = !editing || roleId !== (editing.roles?.id ?? '');
    const emailChanged = !editing || email.trim() !== (editing.email ?? '');

    setLoading(true); setError('');
    try {
      if (editing) {
        await api.patch(`/api/staff/${editing.id}`, {
        hourly_rate: hourlyRate ? Number(hourlyRate) : null,
          name,
          ...(emailChanged ? { email: email.trim() } : {}),   // A506: '' clears it (the cloud stores null)
          ...(roleChanged ? { role_id: roleId } : {}),
          ...(pin ? { pin } : {}),
          ...overrideField,
          ...branchField,
          ...(keysChanged ? { override_keys } : {}),
        });
      } else if (mode === 'pin') {
        await api.post('/api/staff', { name, email: email || undefined, phone: phone || undefined, role_id: roleId, pin, ...branchField, override_keys, ...overrideField });
      } else {
        await api.post('/api/staff/invite', { name, email, role_id: roleId, ...branchField, override_keys, ...overrideField });
      }
      onSaved();
    } catch (err: any) {
      setError(err.message ?? 'Failed to save');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl p-6 space-y-5 max-h-[92vh] overflow-y-auto">
        <h2 className="text-white font-semibold text-lg">{editing ? 'Edit Staff Member' : 'Add Staff Member'}</h2>

        {!editing && (
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {(['pin', 'invite'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-1.5 rounded-md text-sm font-medium transition-colors ${mode === m ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                {m === 'pin' ? '🔢 PIN Login' : '✉️ Email Invite'}
              </button>
            ))}
          </div>
        )}

        {/* Basic info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2 md:col-span-1">
            <label className="block text-sm text-gray-400 mb-1">Full Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Role</label>
            <select value={roleId} onChange={e => handleRoleChange(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift">
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          {(!editing && mode === 'invite') && (
            <div className="sm:col-span-2">
              <label className="block text-sm text-gray-400 mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                name="staff-email" autoComplete="off"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
            </div>
          )}
          {editing && (
            <div className="sm:col-span-2">
              <label className="block text-sm text-gray-400 mb-1">
                Email <span className="text-amber-400 text-xs ml-1">— used for POS login</span>
              </label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                name="staff-email" autoComplete="off"
                placeholder="staff@example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
            </div>
          )}
          {(!editing && mode === 'pin') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Email <span className="text-amber-400 text-xs ml-1">— required for POS login</span>
              </label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                name="staff-email" autoComplete="off"
                placeholder="staff@example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
              <p className="text-xs text-gray-600 mt-1">Staff use their email + PIN to log into the POS terminal.</p>
            </div>
          )}
          {(!editing && mode === 'pin') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Phone (optional)</label>
              <input value={phone} onChange={e => setPhone(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
            </div>
          )}
          {(mode === 'pin' || editing) && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                PIN {editing ? '(leave blank to keep)' : '(4–6 digits)'}
              </label>
              <input type="password" value={pin} onChange={e => setPin(e.target.value)}
                name="staff-pin" autoComplete="new-password"
                maxLength={6} placeholder="••••"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift" />
            </div>
          )}
          <div className="sm:col-span-2">
            <label className="block text-sm text-gray-400 mb-1">
              {/* A518 (owner, 2026-10-16: "rather than them having to remember 2 pins"): the sign-in PIN already approves
                  (lib/approver.ts findApprover); this one is optional. */}
              Approval PIN (optional)
            </label>
            <input
              type="password"
              inputMode="numeric"
              name="staff-override-pin"
              autoComplete="new-password"
              value={overridePin}
              onChange={e => { setOverridePin(e.target.value.replace(/\D/g, '')); setClearOverride(false); }}
              maxLength={6}
              disabled={clearOverride || !mayApprove}
              placeholder={!mayApprove ? 'Give them an approving right first (Void, Refund, Customer credit or Approve with their PIN)' : editing ? '•••• (leave blank to keep)' : '4–6 digits (optional)'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift disabled:opacity-40 tracking-widest"
            />
            <p className="text-xs text-gray-600 mt-1">
              Their sign-in PIN already approves voids, refunds and sales on account. Set a different one only if they would rather not type their sign-in PIN in front of cashiers.
              {editing && (
                <button type="button"
                  onClick={() => { setClearOverride(c => !c); setOverridePin(''); }}
                  className={`ml-2 underline ${clearOverride ? 'text-amber-400' : 'text-gray-500 hover:text-gray-300'}`}>
                  {clearOverride ? 'Will remove the approval PIN — undo' : 'Remove the approval PIN'}
                </button>
              )}
            </p>
          </div>
        </div>

        {/* Branch access — dropdown */}
        {branches.length > 0 && (
          <div>
            <label className="block text-sm text-gray-400 mb-1">Hourly rate (optional)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">KES</span>
              <input type="number" min="0" step="0.5"
                value={hourlyRate} onChange={e => setHourlyRate(e.target.value)}
                placeholder="e.g. 250"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-12 pr-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-swift"
              />
            </div>
            <p className="text-xs text-gray-600 mt-1">Used for labour cost % in the SPLH report.</p>

            <label className="block text-sm text-gray-400 mb-1">Branch Access</label>

            {/* Dropdown trigger */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowBranchDropdown(prev => !prev)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between focus:outline-none focus:border-swift hover:border-gray-500 transition-colors"
              >
                <span className={selectedBranches.length === 0 ? 'text-gray-500' : 'text-white'}>
                  {selectedBranches.length === 0
                    ? 'Select branches…'
                    : branches.filter(b => selectedBranches.includes(b.id)).map(b => b.name).join(', ')}
                </span>
                <span className="text-gray-500 text-xs ml-2">▾</span>
              </button>

              {showBranchDropdown && (
                <div
                  className="absolute z-50 mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden"
                  onMouseDown={e => e.stopPropagation()}
                >
                  {branches.map(b => {
                    const selected = selectedBranches.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => {
                          setSelectedBranches(prev =>
                            prev.includes(b.id) ? prev.filter(id => id !== b.id) : [...prev, b.id]
                          );
                        }}
                        className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-gray-700 transition-colors"
                      >
                        <span className={selected ? 'text-white' : 'text-gray-400'}>{b.name}</span>
                        {selected && <span className="text-green-400 text-xs font-bold">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {selectedBranches.length === 0 && (
              <p className="text-yellow-500/70 text-xs mt-1">⚠ No branch selected — staff will access all branches</p>
            )}
          </div>
        )}

        {/* A490: this person's rights, key by key — pre-filled from the role; what differs from it is marked. */}
        <div>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-white text-sm font-medium">This person's permissions</p>
              <p className="text-gray-500 text-xs">Pre-filled from their role. Tick or untick to give or take away a single permission for this person only.</p>
            </div>
            <span className="text-xs text-gray-500 flex-shrink-0 text-right" data-testid="staff-diff">
              {diffCount === 0 ? 'Same as the role' : `${diffCount} differ${diffCount === 1 ? 's' : ''} from the role`}
              {diffCount > 0 && <button type="button" onClick={() => setEffectiveKeys(new Set(roleBaseline))}
                className="block ml-auto mt-0.5 underline text-gray-400 hover:text-white">Reset to the role</button>}
            </span>
          </div>
          <PermissionPicker keys={catalogue.keys} groups={catalogue.groups} checked={effectiveKeys}
            onChange={setEffectiveKeys} baseline={roleBaseline} idPrefix="staff" />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={loading}
            className="flex-1 bg-swift hover:bg-swift-light disabled:opacity-50 text-gray-950 rounded-xl py-2.5 text-sm font-semibold transition-colors">
            {loading ? 'Saving…' : editing ? 'Save Changes' : mode === 'invite' ? 'Send Invite' : 'Add Staff'}
          </button>
        </div>
      </div>
    </div>
  );
}
