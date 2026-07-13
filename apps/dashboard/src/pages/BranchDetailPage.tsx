import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api";

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_main: boolean;
  status: "active" | "inactive";
}

interface StaffMember {
  id: string;
  name: string;
  phone: string | null;
  status: string;
  role_name: string | null;
}

interface StockItem {
  id: string;
  quantity: number;
  low_stock_threshold: number;
  products: {
    name: string;
    categories: { name: string } | null;
  } | null;
}

export default function BranchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [branch, setBranch] = useState<Branch | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [stock, setStock] = useState<StockItem[]>([]);
  const [tab, setTab] = useState<"staff" | "stock">("staff");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [branchData, staffData, stockData] = await Promise.all([
          api.get<Branch>(`/api/branches/${id}`),
          api.get<StaffMember[]>(`/api/branches/${id}/staff`),
          api.get<StockItem[]>(`/api/branches/${id}/stock`),
        ]);
        setBranch(branchData);
        setStaff(staffData);
        setStock(stockData);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) return (
    <div className="flex-1 flex items-center justify-center bg-gray-950">
      <p className="text-gray-500 text-sm">Loading branch...</p>
    </div>
  );

  if (!branch) return (
    <div className="flex-1 flex items-center justify-center bg-gray-950">
      <p className="text-gray-500 text-sm">Branch not found.</p>
    </div>
  );

  const lowStock = stock.filter(s => s.quantity <= (s.low_stock_threshold ?? 5));

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-gray-950">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link to="/dashboard/branches" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            ← Branches
          </Link>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-xl font-semibold text-white">{branch.name}</h1>
            {branch.is_main && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">
                Main
              </span>
            )}
          </div>
          {branch.address && <p className="text-gray-500 text-xs mt-1">📍 {branch.address}</p>}
        </div>
        <span className={`text-xs px-2 py-1 rounded-full ${branch.status === "active" ? "bg-green-500/10 text-green-400" : "bg-gray-800 text-gray-500"}`}>
          {branch.status}
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-white">{staff.length}</p>
          <p className="text-gray-500 text-xs mt-1">Staff</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
          <p className="text-2xl font-bold text-white">{stock.length}</p>
          <p className="text-gray-500 text-xs mt-1">Products</p>
        </div>
        <div className={`bg-gray-900 border rounded-xl p-4 text-center ${lowStock.length > 0 ? "border-yellow-500/30" : "border-gray-800"}`}>
          <p className={`text-2xl font-bold ${lowStock.length > 0 ? "text-yellow-400" : "text-white"}`}>{lowStock.length}</p>
          <p className="text-gray-500 text-xs mt-1">Low Stock</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-900 border border-gray-800 rounded-lg p-1 w-fit">
        {(["staff", "stock"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-sm rounded-md transition-colors capitalize ${
              tab === t ? "bg-gray-800 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t === "staff" ? `Staff (${staff.length})` : `Stock (${stock.length})`}
          </button>
        ))}
      </div>

      {/* Staff tab */}
      {tab === "staff" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {staff.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-gray-500 text-sm">No staff assigned to this branch yet.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Name</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Role</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Phone</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {staff.map(member => (
                  <tr key={member.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 text-white">{member.name}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-300">
                        {member.role_name ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400">{member.phone ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs ${member.status === "active" ? "text-green-400" : "text-gray-500"}`}>
                        {member.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Stock tab */}
      {tab === "stock" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {stock.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-gray-500 text-sm">No stock records for this branch.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Product</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Category</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Qty</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Threshold</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {stock.map(item => {
                  const isLow = item.quantity <= item.low_stock_threshold;
                  return (
                    <tr key={item.id} className={`border-b border-gray-800/50 transition-colors ${isLow ? "bg-yellow-500/5" : "hover:bg-gray-800/30"}`}>
                      <td className="px-4 py-3 text-white">{item.products?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-400">{item.products?.categories?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-white font-medium">{item.quantity}</td>
                      <td className="px-4 py-3 text-gray-400">{item.low_stock_threshold}</td>
                      <td className="px-4 py-3">
                        {isLow
                          ? <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">Low Stock</span>
                          : <span className="text-xs text-green-400">OK</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
