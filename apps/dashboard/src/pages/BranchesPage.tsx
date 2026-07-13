import { useState } from "react";
import { Link } from "react-router-dom";
import { useBranch } from "../context/BranchContext";
import { api } from "../lib/api";
import ConfirmModal, { useConfirm } from '../components/ConfirmModal';

interface BranchForm {
  name: string;
  address: string;
  phone: string;
}

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_main: boolean;
  status: "active" | "inactive";
}

export default function BranchesPage() {
  const { branches, refetchBranches } = useBranch();
  const [confirmState, showConfirm, closeConfirm] = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<Branch | null>(null);
  const [form, setForm] = useState<BranchForm>({ name: "", address: "", phone: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function openEdit(branch: Branch) {
    setEditTarget(branch);
    setForm({ name: branch.name, address: branch.address ?? "", phone: branch.phone ?? "" });
    setShowForm(true);
  }

  async function handleSave() {
    setError("");
    if (!form.name.trim()) return setError("Branch name is required");
    setSaving(true);
    try {
      if (editTarget) {
        await api.put(`/api/branches/${editTarget.id}`, form);
      } else {
        await api.post("/api/branches", form);
      }
      await refetchBranches();
      setShowForm(false);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save branch");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetMain(branch: Branch) {
    if (branch.is_main) return;
    try {
      await api.put(`/api/branches/${branch.id}/set-main`, {});
      await refetchBranches();
    } catch (err: any) {
      setError(err?.message ?? "Failed to set main branch");
    }
  }

  async function handleDeactivate(branch: Branch) {
    showConfirm({
      title: `Deactivate "${branch.name}"?`,
      message: 'Staff at this branch will lose access immediately.',
      intent: 'warning',
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        await api.delete(`/api/branches/${branch.id}`);
        await refetchBranches();
      },
    });
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-gray-950">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Branches</h1>
          <p className="text-gray-500 text-sm mt-0.5">{branches.length} location{branches.length !== 1 ? "s" : ""}</p>
        </div>
        <span className="text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
          Contact SwiftPOS to add a branch
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(branches as Branch[]).map(branch => (
          <div
            key={branch.id}
            className={`bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-4 ${branch.status === "inactive" ? "opacity-60" : ""}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-white font-medium text-sm">{branch.name}</h3>
                  {branch.is_main && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
                      Main
                    </span>
                  )}
                </div>
                <span className={`text-xs mt-1 inline-block ${branch.status === "active" ? "text-green-400" : "text-gray-500"}`}>
                  {branch.status}
                </span>
              </div>
            </div>

            <div className="space-y-1">
              {branch.address && <p className="text-gray-400 text-xs">📍 {branch.address}</p>}
              {branch.phone && <p className="text-gray-400 text-xs">📞 {branch.phone}</p>}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-gray-800">
              <Link to={`/dashboard/branches/${branch.id}`} className="text-xs text-green-400 hover:text-green-300 transition-colors">
                View Detail →
              </Link>
              <button onClick={() => openEdit(branch)} className="text-xs text-gray-400 hover:text-white transition-colors ml-auto">
                Edit
              </button>
              {!branch.is_main && branch.status === "active" && (
                <>
                  <button onClick={() => handleSetMain(branch)} className="text-xs text-gray-400 hover:text-white transition-colors">
                    Set as Main
                  </button>
                  <button onClick={() => handleDeactivate(branch)} className="text-xs text-red-400 hover:text-red-300 transition-colors">
                    Deactivate
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-semibold text-lg mb-5">{editTarget ? "Edit Branch" : "New Branch"}</h2>

            {error && (
              <p className="mb-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Branch Name *</label>
                <input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Westlands Store"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Address</label>
                <input
                  value={form.address}
                  onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                  placeholder="e.g. Westlands, Nairobi"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>
              <div>
                <label className="block text-gray-400 text-xs mb-1.5">Phone</label>
                <input
                  value={form.phone}
                  onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                  placeholder="e.g. 0700 000 000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-green-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowForm(false)} className="flex-1 px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors">
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving} className="flex-1 px-4 py-2 text-sm font-semibold bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black rounded-lg transition-colors">
                {saving ? "Saving..." : "Save Branch"}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmModal state={confirmState} onClose={closeConfirm} />
    </div>
  );
}
