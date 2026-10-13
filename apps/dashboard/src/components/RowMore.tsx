/**
 * RowMore — a wide table on a phone (A464).
 *
 * Owner, 2026-10-13: "if a table is big you can add a view more to it, display important details … that's when they
 * can click view more". Below sm (640px) a table shows only its key columns; the others carry `DESK` and their values
 * open under the row with "View more". From sm up nothing changes — the button and the details row are `sm:hidden`.
 *
 * Usage:
 *   const more = useRowMore();
 *   <th className={DESK}>Cashier</th>                          // a secondary column: hidden on a phone
 *   <Fragment key={o.id}>
 *     <tr> <td>{o.number} <ViewMore open={more.isOpen(o.id)} onClick={() => more.toggle(o.id)} /></td>
 *          <td className={DESK}>{o.cashier}</td> … </tr>
 *     <MoreRow open={more.isOpen(o.id)} colSpan={3} items={[['Cashier', o.cashier], …]} />
 *   </Fragment>
 */
import { useCallback, useState, type ReactNode } from 'react';

/** A secondary cell: hidden on a phone, a table cell from sm up. */
export const DESK = 'hidden sm:table-cell';

export function useRowMore() {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  const isOpen = useCallback((id: string) => open.has(id), [open]);
  return { isOpen, toggle };
}

/** "View more" under a row's key value — a phone only. Stops the click reaching a clickable row. */
export function ViewMore({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" data-testid="row-more"
      onClick={e => { e.stopPropagation(); onClick(); }}
      className="sm:hidden mt-1 block text-[11px] font-medium text-gray-400 hover:text-white underline underline-offset-2">
      {open ? 'View less' : 'View more'}
    </button>
  );
}

/** The row's other details, opened under it — a phone only. Empty values are left out. */
export function MoreRow({ open, colSpan, items }: { open: boolean; colSpan: number; items: [string, ReactNode][] }) {
  if (!open) return null;
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  return (
    <tr className="sm:hidden" data-testid="row-more-details">
      <td colSpan={colSpan} className="px-4 pb-3 pt-0">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-gray-800/60 border border-gray-700/60 p-3 text-xs">
          {shown.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-gray-500">{label}</dt>
              <dd className="text-gray-200 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  );
}
