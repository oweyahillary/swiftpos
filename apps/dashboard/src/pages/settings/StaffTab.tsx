import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBranch } from '../../context/BranchContext';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Branch { id: string; name: string; }
interface Permission { id: string; key: string; label: string; module: string; }
interface Role {
  id: string; name: string;
  role_permissions: { permission_id: string }[];
}
interface StaffMember {
  id: string; name: string; email: string | null; phone: string | null; status: string;
  hourly_rate: number | null;
  roles: { id: string; name: string } | null;
  user_branches: { branch_id: string; branches: { id: string; name: string } }[];
  user_permissions: { permission_id: string; granted: boolean }[];
}

interface Props {
  branches: Branch[];
  /** Role names to hide from the role selector — used by manager dashboard to prevent assigning manager/owner roles */
  excludeRoles?: string[];
}

const STATUS_COLORS: Record<string, string> = {
  active:   'bg-green-500/15 text-green-400',
  inactive: 'bg-gray-700 text-gray-500',
};

export default function StaffTab({ branches, excludeRoles }: Props) {
  const { activeBranchId } = useBranch();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [mode, setMode] = useState<'pin' | 'invite'>('pin');

  const fetchAll = async () => {
    try {
      const [staffData, rolesData, permsData] = await Promise.all([
        api.get<StaffMember[]>(activeBranchId ? `/api/staff?branch_id=${activeBranchId}` : '/api/staff'),
        api.get<Role[]>('/api/staff/roles'),
        api.get<Permission[]>('/api/staff/permissions'),
      ]);
      setStaff(staffData ?? []);
      // Filter out roles the current context shouldn't be able to assign
      const filteredRoles = excludeRoles?.length
        ? (rolesData ?? []).filter(r => !excludeRoles.includes(r.name.toLowerCase()))
        : (rolesData ?? []);
      setRoles(filteredRoles);
      setPermissions(permsData ?? []);
    } catch (err) { console.error(err); }
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
        await api.delete(`/api/staff/${id}`);
        fetchAll();
      },
    });
  };

  const activate = async (id: string) => {
    await api.patch(`/api/staff/${id}`, { status: 'active' });
    fetchAll();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-lg">Staff Members</h2>
          <p className="text-gray-500 text-sm">{staff.filter(s => s.status === 'active').length} active</p>
        </div>
        <button onClick={() => { setEditing(null); setShowModal(true); }}
          className="px-4 py-2 bg-green-500 hover:bg-green-400 text-gray-950 text-sm font-semibold rounded-xl transition-colors">
          + Add Staff
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-10 text-center">Loading…</div>
      ) : staff.length === 0 ? (
        <div className="text-gray-600 text-sm py-10 text-center">No staff members yet</div>
      ) : (
        <div className="space-y-2">
          {staff.map(s => {
            const branchNames = s.user_branches?.map(b => b.branches?.name).filter(Boolean) ?? [];
            const overrideCount = s.user_permissions?.length ?? 0;
            return (
              <div key={s.id} className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-xl px-4 py-3">
                <div className="flex items-center gap-3">
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
                    </div>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {s.email ?? s.phone ?? 'PIN only'} · {branchNames.length ? branchNames.join(', ') : 'All branches'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => { setEditing(s); setShowModal(true); }}
                    className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700 transition-colors">
                    Edit
                  </button>
                  {s.status === 'active' ? (
                    <button onClick={() => deactivate(s.id)}
                      className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors">
                      Deactivate
                    </button>
                  ) : (
                    <button onClick={() => activate(s.id)}
                      className="text-xs text-green-400 hover:text-green-300 px-3 py-1.5 rounded-lg hover:bg-green-500/10 transition-colors">
                      Activate
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <StaffModal
          editing={editing}
          roles={roles}
          permissions={permissions}
          branches={branches}
          mode={mode}
          setMode={setMode}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); fetchAll(); }}
        />
      )}
    </div>
  );
}

// ── Staff Modal ───────────────────────────────────────────────────────────────
interface ModalProps {
  editing: StaffMember | null;
  roles: Role[];
  permissions: Permission[];
  branches: Branch[];
  mode: 'pin' | 'invite';
  setMode: (m: 'pin' | 'invite') => void;
  onClose: () => void;
  onSaved: () => void;
}

function StaffModal({ editing, roles, permissions, branches, mode, setMode, onClose, onSaved }: ModalProps) {
  const [hourlyRate, setHourlyRate] = useState(editing?.hourly_rate != null ? String(editing.hourly_rate) : '');
  const [name, setName] = useState(editing?.name ?? '');
  const [email, setEmail] = useState(editing?.email ?? '');
  const [phone, setPhone] = useState(editing?.phone ?? '');
  const [roleId, setRoleId] = useState(editing?.roles?.id ?? roles[0]?.id ?? '');
  const [pin, setPin] = useState('');
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

  // effectivePerms: the set of permission IDs currently checked
  // Starts from role defaults, modified by existing user overrides
  const getRolePerms = (rid: string) =>
    new Set(roles.find(r => r.id === rid)?.role_permissions.map(rp => rp.permission_id) ?? []);

  const computeInitial = () => {
    const base = getRolePerms(roleId);
    if (editing?.user_permissions) {
      editing.user_permissions.forEach(up => {
        if (up.granted) base.add(up.permission_id);
        else base.delete(up.permission_id);
      });
    }
    return base;
  };

  const [effectivePerms, setEffectivePerms] = useState<Set<string>>(computeInitial);

  // When role changes, reset effective perms to new role's defaults
  const handleRoleChange = (newRoleId: string) => {
    setRoleId(newRoleId);
    setEffectivePerms(getRolePerms(newRoleId));
  };

  const togglePerm = (permId: string) => {
    setEffectivePerms(prev => {
      const next = new Set(prev);
      next.has(permId) ? next.delete(permId) : next.add(permId);
      return next;
    });
  };

  const toggleModuleAll = (permIds: string[]) => {
    setEffectivePerms(prev => {
      const next = new Set(prev);
      const allOn = permIds.every(id => next.has(id));
      if (allOn) permIds.forEach(id => next.delete(id));
      else permIds.forEach(id => next.add(id));
      return next;
    });
  };

  const toggleBranch = (id: string) =>
    setSelectedBranches(prev => prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]);

  const handleSave = async () => {
    if (!name.trim()) { setError('Name is required'); return; }
    if (!roleId) { setError('Role is required'); return; }
    if (!editing && mode === 'pin' && !pin) { setError('PIN is required'); return; }
    if (!editing && mode === 'invite' && !email) { setError('Email is required'); return; }

    // Compute overrides vs role defaults
    const rolePerms = getRolePerms(roleId);
    const overrides: { permission_id: string; granted: boolean }[] = [];
    permissions.forEach(p => {
      const inRole = rolePerms.has(p.id);
      const inEffective = effectivePerms.has(p.id);
      if (inRole !== inEffective) {
        overrides.push({ permission_id: p.id, granted: inEffective });
      }
    });

    setLoading(true); setError('');
    try {
      if (editing) {
        await api.patch(`/api/staff/${editing.id}`, {
        hourly_rate: hourlyRate ? Number(hourlyRate) : null,
          name,
          email: email || undefined,
          role_id: roleId,
          ...(pin ? { pin } : {}),
          branch_ids: selectedBranches,
          overrides,
        });
      } else if (mode === 'pin') {
        await api.post('/api/staff', { name, phone: phone || undefined, role_id: roleId, pin, branch_ids: selectedBranches, overrides });
      } else {
        await api.post('/api/staff/invite', { name, email, role_id: roleId, branch_ids: selectedBranches, overrides });
      }
      onSaved();
    } catch (err: any) {
      setError(err.message ?? 'Failed to save');
    } finally { setLoading(false); }
  };

  const modules = [...new Set(permissions.map(p => p.module))];

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
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 md:col-span-1">
            <label className="block text-sm text-gray-400 mb-1">Full Name</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Role</label>
            <select value={roleId} onChange={e => handleRoleChange(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500">
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          {(!editing && mode === 'invite') && (
            <div className="col-span-2">
              <label className="block text-sm text-gray-400 mb-1">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
            </div>
          )}
          {editing && (
            <div className="col-span-2">
              <label className="block text-sm text-gray-400 mb-1">
                Email <span className="text-amber-400 text-xs ml-1">— used for POS login</span>
              </label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="staff@example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
            </div>
          )}
          {(!editing && mode === 'pin') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Email <span className="text-amber-400 text-xs ml-1">— required for POS login</span>
              </label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="staff@example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
              <p className="text-xs text-gray-600 mt-1">Staff use their email + PIN to log into the POS terminal.</p>
            </div>
          )}
          {(!editing && mode === 'pin') && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Phone (optional)</label>
              <input value={phone} onChange={e => setPhone(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
            </div>
          )}
          {(mode === 'pin' || editing) && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                PIN {editing ? '(leave blank to keep)' : '(4–6 digits)'}
              </label>
              <input type="password" value={pin} onChange={e => setPin(e.target.value)}
                maxLength={6} placeholder="••••"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
            </div>
          )}
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
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-12 pr-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-green-500"
              />
            </div>
            <p className="text-xs text-gray-600 mt-1">Used for labour cost % in the SPLH report.</p>

            <label className="block text-sm text-gray-400 mb-1">Branch Access</label>

            {/* Dropdown trigger */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowBranchDropdown(prev => !prev)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between focus:outline-none focus:border-green-500 hover:border-gray-500 transition-colors"
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

        {/* Permissions — inline, pre-filled from role */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-white text-sm font-medium">User Rights</p>
              <p className="text-gray-500 text-xs">Pre-filled from the selected role. Check or uncheck to customise for this user.</p>
            </div>
            <span className="text-xs text-gray-500">{effectivePerms.size} active</span>
          </div>

          <div className="space-y-4 bg-gray-800/30 rounded-xl p-4 border border-gray-700/50">
            {modules.map(mod => {
              const modPerms = permissions.filter(p => p.module === mod);
              const modIds = modPerms.map(p => p.id);
              const allOn = modIds.every(id => effectivePerms.has(id));
              const someOn = modIds.some(id => effectivePerms.has(id));

              return (
                <div key={mod}>
                  <div className="flex items-center gap-2 mb-2">
                    <button onClick={() => toggleModuleAll(modIds)}
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                        allOn ? 'bg-green-500 border-green-500'
                        : someOn ? 'bg-green-500/30 border-green-500/50'
                        : 'border-gray-600 hover:border-gray-400'
                      }`}>
                      {(allOn || someOn) && <span className="text-white text-xs font-bold">{allOn ? '✓' : '−'}</span>}
                    </button>
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{mod}</span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 pl-6">
                    {modPerms.map(perm => {
                      const on = effectivePerms.has(perm.id);
                      return (
                        <label key={perm.id} onClick={() => togglePerm(perm.id)}
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                            on ? 'border-green-500/40 bg-green-500/8 text-white' : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-400'
                          }`}>
                          <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                            on ? 'bg-green-500 border-green-500' : 'border-gray-600'
                          }`}>
                            {on && <span className="text-white text-xs font-bold">✓</span>}
                          </div>
                          <span className="text-xs">{perm.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2.5 text-sm font-medium transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={loading}
            className="flex-1 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-gray-950 rounded-xl py-2.5 text-sm font-semibold transition-colors">
            {loading ? 'Saving…' : editing ? 'Save Changes' : mode === 'invite' ? 'Send Invite' : 'Add Staff'}
          </button>
        </div>
      </div>
    </div>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
  );
}
