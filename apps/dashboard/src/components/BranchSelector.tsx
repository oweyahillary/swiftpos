import { useBranch } from "../context/BranchContext";
import BranchPicker from "./BranchPicker";

export default function BranchSelector() {
  const { branches, activeBranch, setActiveBranch, loading, allowAll, allowMine, allLabel } = useBranch();

  // Show loading shimmer while branches fetch
  if (loading) return <div className="mt-1 h-6 bg-gray-800 rounded-md animate-pulse" />;
  // No branches returned — silent failure, show nothing rather than crash
  if (branches.length === 0) return <p className="text-xs text-gray-600 mt-1">No branches</p>;

  // A582: the picker itself is BranchPicker (drawn the same way, tested on its own)
  return (
    <BranchPicker branches={branches} activeId={activeBranch?.id ?? null} allowAll={allowAll} allowMine={allowMine} allLabel={allLabel}
      onPick={(id) => setActiveBranch(id ? branches.find(b => b.id === id) ?? null : null)} />
  );
}
