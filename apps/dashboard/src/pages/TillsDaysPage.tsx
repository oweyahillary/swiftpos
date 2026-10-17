/**
 * TillsDaysPage — A523: the owner's "Tills & days" (Finance › Tills & Days).
 *
 * Owner, 2026-10-17: "there is no location on the cloud where I can close day as the owner or tech support remote force
 * close." Every till of every branch (or the branch picked at the top), its open day and drawers, and the closes waiting
 * for it — with Close day (on the web at once; the till adopts it), Force-close / Close with count, Withdraw, Close as
 * abandoned. components/TillsAndDays.tsx; cloud routes/tills-days.ts.
 */
import TillsAndDays from '../components/TillsAndDays';
import { api } from '../lib/api';
import { useBusiness } from '../context/BusinessContext';

export default function TillsDaysPage() {
  const currency = useBusiness().business?.currency ?? 'KES';
  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Tills &amp; days</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Every till, its open trading day and drawers. Close a till’s day or a drawer from here when nobody can at the till —
          it takes effect on the web at once and the till adopts it when it next connects. Each action asks why, and is
          recorded. A till locks only when there is money to count; an old day with nothing left to count closes itself.
        </p>
      </div>
      <TillsAndDays client={api as any} currency={currency} heading={false} />
    </div>
  );
}
