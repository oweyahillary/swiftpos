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
  // A full-width control: a location pin, the branch, a chevron (the native select underneath — keyboard, phone wheel).
  return (
    <div className="relative">
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-action-400">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" />
      </svg>
    <select
      value={activeId ?? "all"}
      onChange={e => onPick(e.target.value === "all" ? null : e.target.value)}
      aria-label="Branch"
      className={`w-full appearance-none bg-gray-800 text-gray-100 text-sm font-medium rounded-lg pl-8 ${isMulti ? 'pr-8 cursor-pointer hover:bg-gray-700' : 'pr-3 cursor-default'} py-2 border border-gray-700/70 focus:outline-none focus:border-action-500 transition-colors truncate disabled:opacity-100`}
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
      {isMulti && (
        <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400">
          <path d="m6 9 6 6 6-6" />
        </svg>
      )}
    </div>
  );
}
