import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface Permission { id: string; key: string; label: string; module: string; }
interface Role {
  id: string; name: string; description: string | null;
  role_permissions: { permission_id: string }[];
}

interface Props { onRolesChange?: (roles: Role[]) => void; }

export default function RolesTab({ onRolesChange }: Props) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const [localPerms, setLocalPerms] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [showNewRole, setShowNewRole] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPerms, setNewPerms] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  const modules = [...new Set(permissions.map(p => p.module))];

  const fetchAll = async () => {
    try {
      const [rolesData, permsData] = await Promise.all([
        api.get<Role[]>('/api/staff/roles'),
        api.get<Permission[]>('/api/staff/permissions'),
      ]);
      setRoles(rolesData ?? []);
      setPermissions(permsData ?? []);
      const map: Record<string, Set<string>> = {};
      (rolesData ?? []).forEach(r => {
        map[r.id] = new Set(r.role_permissions.map(rp => rp.permission_id));
      });
      setLocalPerms(map);
      onRolesChange?.(rolesData ?? []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, []);

  const togglePerm = (roleId: string, permId: string) => {
    setLocalPerms(prev => {
      const next = { ...prev, [roleId]: new Set(prev[roleId]) };
      if (next[roleId].has(permId)) next[roleId].delete(permId);
      else next[roleId].add(permId);
      return next;
    });
  };

  const toggleAll = (roleId: string, permIds: string[]) => {
    setLocalPerms(prev => {
      const current = prev[roleId] ?? new Set();
      const allChecked = permIds.every(id => current.has(id));
      const next = new Set(current);
      if (allChecked) permIds.forEach(id => next.delete(id));
      else permIds.forEach(id => next.add(id));
      return { ...prev, [roleId]: next };
    });
  };

  const saveRole = async (roleId: string) => {
    setSaving(roleId);
    try {
      await api.put(`/api/staff/roles/${roleId}/permissions`, {
        permission_ids: Array.from(localPerms[roleId] ?? []),
      });
      setSaved(roleId);
      setTimeout(() => setSaved(null), 2000);
      fetchAll();
    } catch (err) { console.error(err); }
    finally { setSaving(null); }
  };

  const createRole = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const role = await api.post<Role>('/api/staff/roles', { name: newName.trim(), description: newDesc.trim() || undefined });
      if (newPerms.size > 0) {
        await api.put(`/api/staff/roles/${role.id}/permissions`, { permission_ids: Array.from(newPerms) });
      }
      setNewName(''); setNewDesc(''); setNewPerms(new Set()); setShowNewRole(false);
      fetchAll();
    } catch (err) { console.error(err); }
    finally { setCreating(false); }
  };

  if (loading) return <div className="text-gray-500 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-lg">Roles</h2>
          <p className="text-gray-500 text-sm">Define what each role can access. Expand a role to edit its permissions.</p>
        </div>
        <button onClick={() => setShowNewRole(!showNewRole)}
          className="px-4 py-2 bg-green-500 hover:bg-green-400 text-gray-950 text-sm font-semibold rounded-xl transition-colors">
          + New Role
        </button>
      </div>

      {/* New role form */}
      {showNewRole && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Role Name</label>
                <input value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. Supervisor"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Description (optional)</label>
                <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
                  placeholder="What this role does"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-green-500" />
              </div>
            </div>
          </div>
          <PermissionGrid
            permissions={permissions}
            modules={modules}
            checked={newPerms}
            onToggle={id => {
              setNewPerms(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
            }}
            onToggleAll={(ids) => {
              setNewPerms(prev => {
                const n = new Set(prev);
                const allOn = ids.every(id => n.has(id));
                if (allOn) ids.forEach(id => n.delete(id));
                else ids.forEach(id => n.add(id));
                return n;
              });
            }}
          />
          <div className="px-4 py-3 border-t border-gray-700 flex gap-3 justify-end">
            <button onClick={() => setShowNewRole(false)}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={createRole} disabled={creating || !newName.trim()}
              className="px-4 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-gray-950 text-sm font-semibold rounded-lg transition-colors">
              {creating ? 'Creating…' : 'Create Role'}
            </button>
          </div>
        </div>
      )}

      {/* Existing roles */}
      <div className="space-y-2">
        {roles.map(role => {
          const isExpanded = expandedRole === role.id;
          const permCount = localPerms[role.id]?.size ?? 0;
          return (
            <div key={role.id} className="border border-gray-700 rounded-xl overflow-hidden">
              {/* Role header */}
              <button onClick={() => setExpandedRole(isExpanded ? null : role.id)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/50 hover:bg-gray-800 transition-colors text-left">
                <div className="flex items-center gap-3">
                  <span className="text-white font-medium capitalize">{role.name}</span>
                  {role.description && <span className="text-gray-500 text-xs">{role.description}</span>}
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">
                    {permCount} permission{permCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <span className="text-gray-500 text-xs">{isExpanded ? '▲' : '▼'}</span>
              </button>

              {/* Permissions grid */}
              {isExpanded && (
                <>
                  <PermissionGrid
                    permissions={permissions}
                    modules={modules}
                    checked={localPerms[role.id] ?? new Set()}
                    onToggle={id => togglePerm(role.id, id)}
                    onToggleAll={ids => toggleAll(role.id, ids)}
                  />
                  <div className="px-4 py-3 border-t border-gray-700 flex justify-end">
                    <button onClick={() => saveRole(role.id)} disabled={saving === role.id}
                      className={`px-5 py-2 rounded-xl text-sm font-semibold transition-colors ${
                        saved === role.id
                          ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                          : 'bg-green-500 hover:bg-green-400 text-gray-950'
                      }`}>
                      {saving === role.id ? 'Saving…' : saved === role.id ? '✓ Saved' : 'Save Changes'}
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Shared Permission Grid ────────────────────────────────────────────────────
interface GridProps {
  permissions: Permission[];
  modules: string[];
  checked: Set<string>;
  onToggle: (permId: string) => void;
  onToggleAll: (permIds: string[]) => void;
}

function PermissionGrid({ permissions, modules, checked, onToggle, onToggleAll }: GridProps) {
  return (
    <div className="p-4 space-y-4">
      {modules.map(mod => {
        const modPerms = permissions.filter(p => p.module === mod);
        const modIds = modPerms.map(p => p.id);
        const allChecked = modIds.every(id => checked.has(id));
        const someChecked = modIds.some(id => checked.has(id));
        return (
          <div key={mod}>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => onToggleAll(modIds)}
                className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                  allChecked ? 'bg-green-500 border-green-500' : someChecked ? 'bg-green-500/30 border-green-500/50' : 'border-gray-600'
                }`}>
                {(allChecked || someChecked) && <span className="text-white text-xs font-bold">{allChecked ? '✓' : '−'}</span>}
              </button>
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{mod}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 pl-7">
              {modPerms.map(perm => (
                <label key={perm.id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                    checked.has(perm.id)
                      ? 'border-green-500/40 bg-green-500/8 text-white'
                      : 'border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}>
                  <div onClick={() => onToggle(perm.id)}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      checked.has(perm.id) ? 'bg-green-500 border-green-500' : 'border-gray-600'
                    }`}>
                    {checked.has(perm.id) && <span className="text-white text-xs font-bold">✓</span>}
                  </div>
                  <span className="text-xs" onClick={() => onToggle(perm.id)}>{perm.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
