/**
 * BranchPicker — the sidebar's branch picker, drawn from what BranchContext knows (BranchSelector passes it). A550: a
 * partner of some branches never gets "All Branches"; A582: such a partner of two or more gets "All my branches (3)" first —
 * their branches combined, never the business's.
 */
export interface PickerBranch { id: string; name: string; is_main?: boolean }

export default function BranchPicker({ branches, activeId, allowAll, allowMine, allLabel, onPick }: {
  branches: PickerBranch[]; activeId: string | null; allowAll: boolean; allowMine: boolean; allLabel: string;
  onPick: (id: string | null) => void;
}) {
  const isMulti = branches.length > 1;
  return (
    <select
      value={activeId ?? "all"}
      onChange={e => onPick(e.target.value === "all" ? null : e.target.value)}
      className="mt-1 w-full bg-gray-800 text-gray-300 text-xs rounded-md px-2 py-1 border border-gray-700 focus:outline-none focus:border-action-500 cursor-pointer"
      // Single branch — show name but don't allow changing (cosmetic only)
      disabled={!isMulti}
      data-testid="branch-picker"
    >
      {/* A550: a partner who works at some branches picks one of them — never "All Branches" */}
      {isMulti && allowAll && (
        <option value="all">🌐 All Branches</option>
      )}
      {/* A582: …or all of theirs together — "All my branches (3)", first, never the business's */}
      {isMulti && !allowAll && allowMine && (
        <option value="all">🌐 {allLabel}</option>
      )}
      {branches.map(b => (
        <option key={b.id} value={b.id}>
          {b.is_main ? "⭐ " : ""}{b.name}
        </option>
      ))}
    </select>
  );
}
