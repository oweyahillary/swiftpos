import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ConfirmModal, { useConfirm } from '../../components/ConfirmModal';

interface Branch { id: string; name: string; is_main: boolean; }
interface Table {
  id: string;
  branch_id: string;
  name: string;
  capacity: number;
  sort_order: number;
  status: 'active' | 'inactive';
}

interface SingleForm { name: string; capacity: number; sort_order: number; }
interface BulkForm {
  prefix: string;       // e.g. "Table"
  startNumber: number;  // e.g. 1
  count: number;        // e.g. 10
  capacity: number;     // e.g. 4
}

const EMPTY_SINGLE: SingleForm = { name: '', capacity: 4, sort_order: 0 };
const EMPTY_BULK: BulkForm = { prefix: 'Table', startNumber: 1, count: 10, capacity: 4 };

type ModalMode = 'single' | 'bulk';

export default function TablesTab({ branches }: { branches: Branch[] }) {
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [selectedBranchId, setSelectedBranchId] = useState<string>('');
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>('single');
  const [editing, setEditing] = useState<Table | null>(null);
  const [singleForm, setSingleForm] = useState<SingleForm>(EMPTY_SINGLE);
  const [bulkForm, setBulkForm] = useState<BulkForm>(EMPTY_BULK);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0); // for bulk progress
  const [error, setError] = useState('');

  // Auto-select main branch
  useEffect(() => {
    if (branches.length > 0 && !selectedBranchId) {
      setSelectedBranchId(branches.find((b) => b.is_main)?.id ?? branches[0].id);
    }
  }, [branches, selectedBranchId]);

  // Fetch tables on branch change
  useEffect(() => {
    if (!selectedBranchId) return;
    setLoading(true);
    api
      .get<Table[]>(`/api/tables/all?branch_id=${selectedBranchId}`)
      .then((data) => setTables(data ?? []))
      .catch(() => setTables([]))
      .finally(() => setLoading(false));
  }, [selectedBranchId]);

  async function refreshTables() {
    const data = await api.get<Table[]>(`/api/tables/all?branch_id=${selectedBranchId}`);
    setTables(data ?? []);
  }

  // ── Open modal ─────────────────────────────────────────────────────────────

  function openAdd() {
    setEditing(null);
    setSingleForm({ ...EMPTY_SINGLE, sort_order: tables.filter(t => t.status === 'active').length });
    setBulkForm({ ...EMPTY_BULK, startNumber: tables.filter(t => t.status === 'active').length + 1 });
    setModalMode('single');
    setError('');
    setSaveProgress(0);
    setShowModal(true);
  }

  function openEdit(table: Table) {
    setEditing(table);
    setSingleForm({ name: table.name, capacity: table.capacity, sort_order: table.sort_order });
    setModalMode('single'); // edit is always single
    setError('');
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditing(null);
    setError('');
    setSaveProgress(0);
  }

  // ── Bulk preview names ─────────────────────────────────────────────────────

  function bulkPreviewNames(form: BulkForm): string[] {
    return Array.from({ length: Math.min(form.count, 5) }, (_, i) =>
      `${form.prefix} ${form.startNumber + i}`
    );
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function handleSave() {
    setError('');
    setSaving(true);

    try {
      if (editing) {
        // ── Edit single ──
        if (!singleForm.name.trim()) { setError('Table name is required'); return; }
        await api.patch(`/api/tables/${editing.id}`, {
          name: singleForm.name.trim(),
          capacity: singleForm.capacity,
          sort_order: singleForm.sort_order,
        });
        await refreshTables();
        closeModal();

      } else if (modalMode === 'single') {
        // ── Add single ──
        if (!singleForm.name.trim()) { setError('Table name is required'); return; }
        await api.post('/api/tables', {
          branch_id: selectedBranchId,
          name: singleForm.name.trim(),
          capacity: singleForm.capacity,
          sort_order: singleForm.sort_order,
        });
        await refreshTables();
        closeModal();

      } else {
        // ── Bulk add ──
        if (!bulkForm.prefix.trim()) { setError('Prefix is required'); return; }
        if (bulkForm.count < 1 || bulkForm.count > 50) { setError('Count must be between 1 and 50'); return; }

        const baseOrder = tables.filter(t => t.status === 'active').length;
        let created = 0;
        const errors: string[] = [];

        for (let i = 0; i < bulkForm.count; i++) {
          const name = `${bulkForm.prefix.trim()} ${bulkForm.startNumber + i}`;
          try {
            await api.post('/api/tables', {
              branch_id: selectedBranchId,
              name,
              capacity: bulkForm.capacity,
              sort_order: baseOrder + i,
            });
            created++;
            setSaveProgress(Math.round(((i + 1) / bulkForm.count) * 100));
          } catch (err: any) {
            // Duplicate name — skip gracefully
            if (err.message?.includes('already exists')) {
              errors.push(`"${name}" already exists, skipped`);
            } else {
              errors.push(`"${name}" failed`);
            }
          }
        }

        await refreshTables();

        if (errors.length > 0) {
          setError(`Created ${created} tables. Skipped: ${errors.join(', ')}`);
          // Don't close — show the partial error
        } else {
          closeModal();
        }
      }
    } catch (err: any) {
      setError(err.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  // ── Toggle / Delete ────────────────────────────────────────────────────────

  async function toggleStatus(table: Table) {
    const newStatus = table.status === 'active' ? 'inactive' : 'active';
    const label = newStatus === 'inactive' ? 'Deactivate' : 'Reactivate';
    showConfirm({
      title: `${label} "${table.name}"?`,
      message: newStatus === 'inactive' ? 'The table will be hidden from the floor plan.' : 'The table will reappear on the floor plan.',
      intent: newStatus === 'inactive' ? 'warning' : 'neutral',
      confirmLabel: label,
      onConfirm: async () => {
        await api.patch(`/api/tables/${table.id}`, { status: newStatus });
        setTables((prev) => prev.map((t) => (t.id === table.id ? { ...t, status: newStatus } : t)));
      },
    });
  }

  async function handleDelete(table: Table) {
    showConfirm({
      title: `Delete "${table.name}"?`,
      message: 'This permanently removes the table. This cannot be undone.',
      intent: 'destructive',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api.delete(`/api/tables/${table.id}`);
        setTables((prev) => prev.filter((t) => t.id !== table.id));
      },
    });
  }

  const activeTables = tables.filter((t) => t.status === 'active');
  const inactiveTables = tables.filter((t) => t.status === 'inactive');

  // Bulk save button label
  const bulkSaveLabel = saving
    ? `Creating… ${saveProgress}%`
    : `Create ${bulkForm.count} Table${bulkForm.count !== 1 ? 's' : ''}`;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold text-lg">Tables</h2>
          <p className="text-gray-500 text-sm">
            {activeTables.length} active table{activeTables.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={openAdd}
          disabled={!selectedBranchId}
          className="px-4 py-2 bg-green-500 hover:bg-green-400 disabled:opacity-40 disabled:cursor-not-allowed text-gray-950 text-sm font-semibold rounded-xl transition-colors"
        >
          + Add Tables
        </button>
      </div>

      {/* Branch selector */}
      {branches.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-gray-400 text-sm whitespace-nowrap">Branch:</label>
          <select
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-green-500"
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}{b.is_main ? ' (Main)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && <div className="text-gray-500 text-sm py-10 text-center">Loading tables…</div>}

      {!loading && (
        <>
          {activeTables.length === 0 ? (
            <div className="text-center py-12 border border-dashed border-gray-800 rounded-xl">
              <div className="text-3xl mb-3">🪑</div>
              <p className="text-gray-500 text-sm">No tables yet for this branch.</p>
              <p className="text-gray-600 text-xs mt-1">Use "Add Tables" to create one or many at once.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {activeTables.map((table) => (
                <TableCard key={table.id} table={table}
                  onEdit={() => openEdit(table)}
                  onToggle={() => toggleStatus(table)}
                  onDelete={() => handleDelete(table)}
                />
              ))}
            </div>
          )}

          {inactiveTables.length > 0 && (
            <details className="mt-2">
              <summary className="text-gray-600 text-sm cursor-pointer select-none hover:text-gray-400 transition-colors">
                {inactiveTables.length} inactive table{inactiveTables.length !== 1 ? 's' : ''} (hidden from cashier)
              </summary>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                {inactiveTables.map((table) => (
                  <TableCard key={table.id} table={table}
                    onEdit={() => openEdit(table)}
                    onToggle={() => toggleStatus(table)}
                    onDelete={() => handleDelete(table)}
                  />
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {/* ── Modal ─────────────────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">

            {/* Modal header */}
            <div className="px-6 pt-6 pb-4">
              <h3 className="text-white font-semibold text-lg mb-4">
                {editing ? `Edit ${editing.name}` : 'Add Tables'}
              </h3>

              {/* Single / Bulk tabs — only for adding, not editing */}
              {!editing && (
                <div className="flex bg-gray-800 rounded-xl p-1 gap-1">
                  <button
                    onClick={() => { setModalMode('single'); setError(''); }}
                    className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      modalMode === 'single'
                        ? 'bg-gray-700 text-white'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Single Table
                  </button>
                  <button
                    onClick={() => { setModalMode('bulk'); setError(''); }}
                    className={`flex-1 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      modalMode === 'bulk'
                        ? 'bg-gray-700 text-white'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Bulk Add
                  </button>
                </div>
              )}
            </div>

            {/* Modal body */}
            <div className="px-6 pb-2 space-y-4">

              {/* ── SINGLE form ── */}
              {(modalMode === 'single' || editing) && (
                <>
                  <div>
                    <label className="text-gray-400 text-xs font-medium block mb-1">Table Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Table 1, Patio 3, Bar 2"
                      value={singleForm.name}
                      onChange={(e) => setSingleForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 transition-colors"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-gray-400 text-xs font-medium block mb-1">Capacity (seats)</label>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setSingleForm((f) => ({ ...f, capacity: Math.max(1, f.capacity - 1) }))}
                        className="w-9 h-9 bg-gray-800 border border-gray-700 rounded-lg text-white text-lg flex items-center justify-center hover:bg-gray-700 transition-colors"
                      >−</button>
                      <span className="text-white font-bold text-xl w-8 text-center">{singleForm.capacity}</span>
                      <button
                        onClick={() => setSingleForm((f) => ({ ...f, capacity: Math.min(50, f.capacity + 1) }))}
                        className="w-9 h-9 bg-gray-800 border border-gray-700 rounded-lg text-white text-lg flex items-center justify-center hover:bg-gray-700 transition-colors"
                      >+</button>
                    </div>
                  </div>
                  <div>
                    <label className="text-gray-400 text-xs font-medium block mb-1">Display Order</label>
                    <input
                      type="number" min={0}
                      value={singleForm.sort_order}
                      onChange={(e) => setSingleForm((f) => ({ ...f, sort_order: Number(e.target.value) }))}
                      className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 transition-colors"
                    />
                    <p className="text-gray-600 text-xs mt-1">Lower numbers appear first in the cashier grid.</p>
                  </div>
                </>
              )}

              {/* ── BULK form ── */}
              {modalMode === 'bulk' && !editing && (
                <>
                  {/* Prefix + start */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-gray-400 text-xs font-medium block mb-1">Prefix *</label>
                      <input
                        type="text"
                        placeholder="e.g. Table, Patio"
                        value={bulkForm.prefix}
                        onChange={(e) => setBulkForm((f) => ({ ...f, prefix: e.target.value }))}
                        className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-green-500 transition-colors"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="text-gray-400 text-xs font-medium block mb-1">Start Number</label>
                      <input
                        type="number" min={1}
                        value={bulkForm.startNumber}
                        onChange={(e) => setBulkForm((f) => ({ ...f, startNumber: Number(e.target.value) }))}
                        className="w-full bg-gray-800 border border-gray-700 text-white rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-green-500 transition-colors"
                      />
                    </div>
                  </div>

                  {/* Count + capacity */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-gray-400 text-xs font-medium block mb-1">
                        Number of Tables
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setBulkForm((f) => ({ ...f, count: Math.max(1, f.count - 1) }))}
                          className="w-9 h-9 bg-gray-800 border border-gray-700 rounded-lg text-white flex items-center justify-center hover:bg-gray-700 transition-colors text-lg"
                        >−</button>
                        <span className="text-white font-bold text-xl w-8 text-center">{bulkForm.count}</span>
                        <button
                          onClick={() => setBulkForm((f) => ({ ...f, count: Math.min(50, f.count + 1) }))}
                          className="w-9 h-9 bg-gray-800 border border-gray-700 rounded-lg text-white flex items-center justify-center hover:bg-gray-700 transition-colors text-lg"
                        >+</button>
                      </div>
                    </div>
                    <div>
                      <label className="text-gray-400 text-xs font-medium block mb-1">
                        Seats Each
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setBulkForm((f) => ({ ...f, capacity: Math.max(1, f.capacity - 1) }))}
                          className="w-9 h-9 bg-gray-800 border border-gray-700 rounded-lg text-white flex items-center justify-center hover:bg-gray-700 transition-colors text-lg"
                        >−</button>
                        <span className="text-white font-bold text-xl w-8 text-center">{bulkForm.capacity}</span>
                        <button
                          onClick={() => setBulkForm((f) => ({ ...f, capacity: Math.min(50, f.capacity + 1) }))}
                          className="w-9 h-9 bg-gray-800 border border-gray-700 rounded-lg text-white flex items-center justify-center hover:bg-gray-700 transition-colors text-lg"
                        >+</button>
                      </div>
                    </div>
                  </div>

                  {/* Preview */}
                  {bulkForm.prefix.trim() && bulkForm.count > 0 && (
                    <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-3">
                      <p className="text-gray-400 text-xs font-medium mb-2">Preview</p>
                      <p className="text-white text-sm">
                        {bulkPreviewNames(bulkForm).join(', ')}
                        {bulkForm.count > 5 && (
                          <span className="text-gray-500"> … +{bulkForm.count - 5} more</span>
                        )}
                      </p>
                      <p className="text-gray-500 text-xs mt-1">
                        {bulkForm.count} table{bulkForm.count !== 1 ? 's' : ''} · {bulkForm.capacity} seats each
                      </p>
                    </div>
                  )}

                  {/* Progress bar during save */}
                  {saving && (
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Creating tables…</span>
                        <span>{saveProgress}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-green-500 rounded-full transition-all duration-200"
                          style={{ width: `${saveProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Error */}
              {error && (
                <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex gap-3 px-6 py-5">
              <button
                onClick={closeModal}
                disabled={saving}
                className="flex-1 px-4 py-2.5 bg-gray-800 text-gray-400 rounded-xl text-sm font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
              >
                {error && modalMode === 'bulk' ? 'Close' : 'Cancel'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 px-4 py-2.5 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-gray-950 rounded-xl text-sm font-semibold transition-colors"
              >
                {editing
                  ? (saving ? 'Saving…' : 'Save Changes')
                  : modalMode === 'bulk'
                  ? bulkSaveLabel
                  : (saving ? 'Saving…' : 'Add Table')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── TableCard ─────────────────────────────────────────────────────────────────

function TableCard({ table, onEdit, onToggle, onDelete }: {
  table: Table; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const isActive = table.status === 'active';
  return (
    <div className={`flex items-center justify-between border rounded-xl px-4 py-3 transition-colors ${
      isActive ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-900/40 border-gray-800 opacity-60'
    }`}>
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg ${isActive ? 'bg-gray-700' : 'bg-gray-800'}`}>
          🪑
        </div>
        <div>
          <div className="text-white text-sm font-semibold">{table.name}</div>
          <div className="text-gray-500 text-xs">👥 {table.capacity} seats · order #{table.sort_order}</div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={onEdit} className="p-1.5 text-gray-500 hover:text-white transition-colors rounded-lg hover:bg-gray-700" title="Edit">✏️</button>
        <button onClick={onToggle} className={`p-1.5 transition-colors rounded-lg hover:bg-gray-700 ${isActive ? 'text-gray-500 hover:text-yellow-400' : 'text-gray-600 hover:text-green-400'}`} title={isActive ? 'Deactivate' : 'Reactivate'}>
          {isActive ? '⏸' : '▶'}
        </button>
        <button onClick={onDelete} className="p-1.5 text-gray-600 hover:text-red-400 transition-colors rounded-lg hover:bg-gray-700" title="Delete">🗑</button>
      </div>
    </div>
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
  );
}
