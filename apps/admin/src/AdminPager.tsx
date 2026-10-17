/**
 * AdminPager — A475: a long admin list in pages (the admin portal's own look — inline styles, no Tailwind).
 *
 * Owner, 2026-10-14: "on pagination do it on every page that has more than 50 items to show". The same maths as the
 * web and the till (lib/paginate.ts — one file, shared/paginate.ts, kept identical by scripts/check-shared-sync.mjs):
 * "Showing 51–100 of 1,234", 25 / 50 / 100 a page (kept per list in this browser), First / Prev / 1 … 4 5 6 … / Next / Last.
 *
 * Usage:
 *   const [size, setSize] = usePageSize('swiftpos.admin.pageSize.audit');
 *   const paged = paginate(rows, page, size);
 *   <AdminPager paged={paged} onPage={setPage} onSize={n => { setSize(n); setPage(1); }} />
 */
import { useCallback, useState } from "react";
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, cleanPageSize, pageWindow, rangeLabel, type Paged } from "./lib/paginate";
import { C, S } from "./theme";

/** The page size for one list, remembered in this browser. Storage may be blocked: then 50. */
export function usePageSize(key: string): [number, (n: number) => void] {
  const [size, setSize] = useState<number>(() => {
    try { return cleanPageSize(localStorage.getItem(key)); } catch { return DEFAULT_PAGE_SIZE; }
  });
  const set = useCallback((n: number) => {
    const c = cleanPageSize(n);
    setSize(c);
    try { localStorage.setItem(key, String(c)); } catch { /* not remembered — still applied */ }
  }, [key]);
  return [size, set];
}

const btn = (on: boolean, disabled = false) => ({
  ...S.btn, ...S.btnGhost, fontSize: 12, padding: "5px 10px", minWidth: 34,
  ...(on ? { background: "rgba(56,225,255,0.12)", color: C.accent, border: `1px solid ${C.accent}` } : {}),
  ...(disabled ? { opacity: 0.4, cursor: "not-allowed" } : {}),
});

export default function AdminPager({ paged, onPage, onSize }: {
  paged: Paged<unknown>;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  const { page, pages, size } = paged;
  // Owner, 2026-10-17: the pager shows only when there is more than one page — not "Showing 1–4 of 4" under a short list.
  if (pages <= 1) return null;
  const first = page <= 1, last = page >= pages;
  return (
    <nav data-testid="pager" aria-label="Pages"
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 12, marginTop: 4, borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, color: C.muted }}>
        <span data-testid="pager-range" style={{ fontVariantNumeric: "tabular-nums" }}>{rangeLabel(paged)}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          Per page
          <select data-testid="pager-size" value={size} onChange={e => onSize(Number(e.target.value))}
            style={{ ...S.input, width: "auto", padding: "4px 8px", fontSize: 12 }}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      {pages > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          <button type="button" data-testid="pager-first" style={btn(false, first)} disabled={first} onClick={() => onPage(1)}>First</button>
          <button type="button" data-testid="pager-prev" style={btn(false, first)} disabled={first} onClick={() => onPage(page - 1)}>Prev</button>
          {pageWindow(page, pages).map((slot, i) => slot === "gap"
            ? <span key={`gap-${i}`} style={{ padding: "0 4px", color: C.muted }} aria-hidden>…</span>
            : <button key={slot} type="button" data-testid="pager-page" aria-current={slot === page ? "page" : undefined}
                style={btn(slot === page)} onClick={() => onPage(slot)}>{slot}</button>)}
          <button type="button" data-testid="pager-next" style={btn(false, last)} disabled={last} onClick={() => onPage(page + 1)}>Next</button>
          <button type="button" data-testid="pager-last" style={btn(false, last)} disabled={last} onClick={() => onPage(pages)}>Last</button>
        </div>
      )}
    </nav>
  );
}
