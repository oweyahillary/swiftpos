/**
 * RolesTab — Settings › Users and access › Roles and permissions (A490): the ONE place the owner sets what each role
 * may see and do, key by key, from the shared catalogue (lib/permissions.ts, served by the cloud).
 *
 * API (cloud, routes/staff.ts):
 *   GET    /api/staff/roles                       — each role: keys (fine), is_owner_role, assignable, editable, members
 *   GET    /api/staff/permissions                 — the catalogue (key, label, description, group, surface)
 *   GET    /api/staff/permission-groups           — its groups, in order
 *   PUT    /api/staff/roles/:id/permissions {keys}
 *   POST   /api/staff/roles {name, description?, keys?, copy_from?}
 *   PATCH  /api/staff/roles/:id {name?, description?}
 *   DELETE /api/staff/roles/:id                   — 409 ROLE_IN_USE { members } while anyone holds it
 * The owner's role is everything ('*') and is never edited here.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';
import PermissionPicker, { usePermissionCatalogue } from '../../components/PermissionPicker';
import { useBusiness } from '../../context/BusinessContext';   // A573
import { posWording } from '@zaptill/core/businessTerms';           // A586: a built-in role's stored words say "till"

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  /** A490: the role's FINE keys. */
  keys?: string[];
  is_owner_role?: boolean;
  assignable?: boolean;
  editable?: boolean;
  members?: number;
}

interface Props { onRolesChange?: (roles: RoleRow[]) => void; }

const input = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-swift';
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((k) => b.has(k));
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** The 409 the cloud answers while someone still holds the role. */
export function roleInUseMessage(name: string, members: unknown): string {
  const n = Number(members);
  return Number.isFinite(n) && n > 0
    ? `${people(n)} ${n === 1 ? 'has' : 'have'} the ${name} role. Give ${n === 1 ? 'them' : 'each of them'} another role first, then delete it.`
    : `Someone still has the ${name} role. Give them another role first, then delete it.`;
}

export default function RolesTab({ onRolesChange }: Props) {
  const catalogue = usePermissionCatalogue(api, useBusiness().business?.type);   // A573: a shop's words
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [confirmState, showConfirm, closeConfirm] = useConfirm();

  // The role being edited, and its unsaved keys.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Rename (inline) and new role.
  const [renaming, setRenaming] = useState<{ id: string; name: string; description: string } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fetchRoles = async () => {
    try {
      const data = await api.get<RoleRow[]>('/api/staff/roles');
      setRoles(data ?? []);
      setLoadError('');
      onRolesChange?.(data ?? []);
      return data ?? [];
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load the roles');
      return [];
    } finally { setLoading(false); }
  };
  useEffect(() => { void fetchRoles(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const fine = useMemo(() => new Set(catalogue.keys.map((k) => k.key)), [catalogue.keys]);
  const roleKeys = (r: RoleRow | undefined) => new Set((r?.keys ?? []).filter((k) => k === '*' || fine.size === 0 || fine.has(k)));
  const editingRole = roles.find((r) => r.id === editingId);
  const dirty = !!editingRole && !sameSet(draft, roleKeys(editingRole));

  // Unsaved-changes guard: leaving the page (or closing the tab) with changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** Run `go` now, or after the owner agrees to drop the unsaved changes. */
  const leaveEditor = (go: () => void) => {
    if (!dirty) { go(); return; }
    showConfirm({
      title: 'Leave without saving?',
      message: `Your changes to ${editingRole?.name ?? 'this role'} are not saved.`,
      intent: 'warning', confirmLabel: 'Leave without saving', cancelLabel: 'Keep editing',
      onConfirm: () => go(),
    });
  };

  const openEditor = (r: RoleRow) => leaveEditor(() => {
    setEditingId(r.id); setDraft(roleKeys(r)); setSaveMsg(null); setRenaming(null);
  });
  const closeEditor = () => leaveEditor(() => { setEditingId(null); setSaveMsg(null); });

  const save = async () => {
    if (!editingRole) return;
    setSaving(true); setSaveMsg(null);
    try {
      await api.put(`/api/staff/roles/${editingRole.id}/permissions`, { keys: [...draft].filter((k) => k !== '*') });
      const fresh = await fetchRoles();
      const r = fresh.find((x) => x.id === editingRole.id);
      if (r) setDraft(roleKeys(r));
      setSaveMsg({ ok: true, text: 'Saved — it applies the next time each person signs in or their POS refreshes.' });
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e?.message ?? 'Could not save' });
    } finally { setSaving(false); }
  };

  const create = async () => {
    if (!newName.trim()) { setError('Give the role a name.'); return; }
    setBusy(true); setError('');
    try {
      const role = await api.post<RoleRow>('/api/staff/roles', {
        name: newName.trim(),
        ...(newDesc.trim() ? { description: newDesc.trim() } : {}),
        ...(copyFrom ? { copy_from: copyFrom } : { keys: [] }),
      });
      setShowNew(false); setNewName(''); setNewDesc(''); setCopyFrom('');
      const fresh = await fetchRoles();
      const r = fresh.find((x) => x.id === role?.id);
      if (r) { setEditingId(r.id); setDraft(roleKeys(r)); setSaveMsg(null); }
    } catch (e: any) {
      setError(e?.message ?? 'Could not create the role');
    } finally { setBusy(false); }
  };

  const rename = async () => {
    if (!renaming) return;
    if (!renaming.name.trim()) { setError('The role needs a name.'); return; }
    setBusy(true); setError('');
    try {
      await api.patch(`/api/staff/roles/${renaming.id}`, { name: renaming.name.trim(), description: renaming.description.trim() || null });
      setRenaming(null);
      await fetchRoles();
    } catch (e: any) {
      setError(e?.message ?? 'Could not rename the role');
    } finally { setBusy(false); }
  };

  const remove = (r: RoleRow) => {
    setError('');
    if ((r.members ?? 0) > 0) { setError(roleInUseMessage(r.name, r.members)); return; }
    showConfirm({
      title: `Delete the ${r.name} role?`,
      message: 'Nobody has it. This cannot be undone.',
      intent: 'destructive', confirmLabel: 'Delete role',
      onConfirm: async () => {
        try {
          await api.delete(`/api/staff/roles/${r.id}`);
          if (editingId === r.id) setEditingId(null);
          await fetchRoles();
        } catch (e: any) {
          setError(e?.code === 'ROLE_IN_USE' || e?.status === 409 ? roleInUseMessage(r.name, e?.members) : (e?.message ?? 'Could not delete the role'));
        }
      },
    });
  };

  if (loading || catalogue.loading) return <div className="text-gray-500 text-sm py-10 text-center">Loading…</div>;

  const total = catalogue.keys.length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h2 className="text-white font-semibold text-lg">Roles and permissions</h2>
          <p className="text-gray-500 text-sm">What each role may see and do — every screen, report and action, on the web and the points of sale. A person can also be given or refused single permissions on their staff card.</p>
        </div>
        <button onClick={() => leaveEditor(() => { setEditingId(null); setShowNew(true); setError(''); })} data-testid="new-role"
          className="px-4 py-2 bg-swift hover:bg-swift-light text-gray-950 text-sm font-semibold rounded-xl transition-colors">
          + New role
        </button>
      </div>

      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {error && <p className="text-sm text-red-400" data-testid="roles-error">{error}</p>}

      {showNew && (
        <div className="rounded-xl border border-gray-700 bg-gray-800/50 p-4 space-y-3">
          <p className="text-white text-sm font-medium">New role</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs text-gray-400">Name
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Supervisor" className={`${input} mt-1`} />
            </label>
            <label className="block text-xs text-gray-400">Description (optional)
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What this role does" className={`${input} mt-1`} />
            </label>
            <label className="block text-xs text-gray-400 sm:col-span-2">Start from
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} className={`${input} mt-1`} data-testid="new-role-copy">
                <option value="">Nothing — I'll tick what it may do</option>
                {roles.filter((r) => !r.is_owner_role).map((r) => <option key={r.id} value={r.id}>A copy of {r.name}</option>)}
              </select>
            </label>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setShowNew(false); setError(''); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded-lg transition-colors">Cancel</button>
            <button onClick={create} disabled={busy || !newName.trim()}
              className="px-4 py-2 bg-swift hover:bg-swift-light disabled:opacity-50 text-gray-950 text-sm font-semibold rounded-lg transition-colors">
              {busy ? 'Creating…' : 'Create and set permissions'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {roles.map((r) => {
          const owner = !!r.is_owner_role;
          const held = roleKeys(r);
          const count = owner ? total : [...held].filter((k) => k !== '*').length;
          const isEditing = editingId === r.id;
          const canEdit = !owner && r.editable !== false;
          const isRenaming = renaming?.id === r.id;
          return (
            <div key={r.id} className={`rounded-xl border overflow-hidden ${isEditing ? 'border-swift/40' : 'border-gray-700'}`} data-testid={`role-${r.id}`}>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 bg-gray-800/50">
                {isRenaming ? (
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} aria-label="Role name" className={input} />
                    <input value={renaming.description} onChange={(e) => setRenaming({ ...renaming, description: e.target.value })} aria-label="Description" placeholder="Description (optional)" className={input} />
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-white font-medium capitalize">{r.name}</span>
                      {owner && <span className="text-[10px] uppercase tracking-wide rounded border border-gray-600 px-1.5 py-px text-gray-400">Locked</span>}
                      <span className="text-xs text-gray-500">{people(r.members ?? 0)}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {owner ? 'Everything — the owner\'s role' : `${count} of ${total} permissions`}{r.description ? ` · ${posWording(r.description)}` : ''}
                    </p>
                  </div>
                )}
                <div className="flex items-center gap-1 flex-wrap">
                  {isRenaming ? (<>
                    <button onClick={() => setRenaming(null)} className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700">Cancel</button>
                    <button onClick={rename} disabled={busy} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-swift hover:bg-swift-light text-gray-950 disabled:opacity-50">Save name</button>
                  </>) : canEdit ? (<>
                    <button onClick={() => (isEditing ? closeEditor() : openEditor(r))} data-testid={`edit-role-${r.id}`}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-swift/50 text-swift-text hover:bg-swift/10">
                      {isEditing ? 'Close' : 'Edit permissions'}
                    </button>
                    <button onClick={() => leaveEditor(() => { setEditingId(null); setRenaming({ id: r.id, name: r.name, description: r.description ?? '' }); })}
                      className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700">Rename</button>
                    <button onClick={() => remove(r)} data-testid={`delete-role-${r.id}`}
                      className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg hover:bg-red-500/10">Delete</button>
                  </>) : owner ? null : (
                    <button onClick={() => (isEditing ? closeEditor() : openEditor(r))}
                      className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-700">{isEditing ? 'Close' : 'View'}</button>
                  )}
                </div>
              </div>

              {isEditing && (
                <div className="p-3 sm:p-4 space-y-4 border-t border-gray-700">
                  <PermissionPicker keys={catalogue.keys} groups={catalogue.groups} checked={draft}
                    onChange={setDraft} readOnly={!canEdit} idPrefix={`role-${r.id}`} />
                  {canEdit && (
                    <div className="sticky bottom-0 -mx-3 sm:-mx-4 -mb-3 sm:-mb-4 px-3 sm:px-4 py-3 border-t border-gray-700 bg-gray-900 flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2">
                      {saveMsg && <span className={`text-xs sm:mr-auto ${saveMsg.ok ? 'text-gray-400' : 'text-red-400'}`}>{saveMsg.text}</span>}
                      {dirty && !saveMsg && <span className="text-xs text-amber-300 sm:mr-auto">Unsaved changes</span>}
                      <div className="flex gap-2">
                        <button onClick={() => { setDraft(roleKeys(r)); setSaveMsg(null); }} disabled={!dirty || saving}
                          className="flex-1 sm:flex-none px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg">Cancel</button>
                        <button onClick={save} disabled={!dirty || saving} data-testid="save-role"
                          className="flex-1 sm:flex-none px-5 py-2 bg-swift hover:bg-swift-light disabled:opacity-40 text-gray-950 text-sm font-semibold rounded-lg">
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
