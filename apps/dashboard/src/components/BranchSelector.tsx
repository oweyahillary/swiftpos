import { useBranch } from "../context/BranchContext";

export default function BranchSelector() {
  const { branches, activeBranch, setActiveBranch, loading } = useBranch();

  // Show loading shimmer while branches fetch
  if (loading) return <div className="mt-1 h-6 bg-gray-800 rounded-md animate-pulse" />;
  // No branches returned — silent failure, show nothing rather than crash
  if (branches.length === 0) return <p className="text-xs text-gray-600 mt-1">No branches</p>;

  const isMulti = branches.length > 1;

  return (
    <select
      value={activeBranch?.id ?? "all"}
      onChange={e => {
        const val = e.target.value;
        if (val === "all") { setActiveBranch(null); return; }
        const selected = branches.find(b => b.id === val) ?? null;
        setActiveBranch(selected);
      }}
      className="mt-1 w-full bg-gray-800 text-gray-300 text-xs rounded-md px-2 py-1 border border-gray-700 focus:outline-none focus:border-green-500 cursor-pointer"
      // Single branch — show name but don't allow changing (cosmetic only)
      disabled={!isMulti}
    >
      {isMulti && (
        <option value="all">🌐 All Branches</option>
      )}
      {branches.map(b => (
        <option key={b.id} value={b.id}>
          {b.is_main ? "⭐ " : ""}{b.name}
        </option>
      ))}
    </select>
  );
}
