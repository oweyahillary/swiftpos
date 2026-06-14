/**
 * POSPage.tsx
 *
 * The full POS terminal lives at /pos (CashierScreen via POSEntryPage).
 * This route ( /dashboard/pos ) now redirects there so the dashboard
 * nav link drops the user straight into the PIN entry flow.
 */
import { Navigate } from 'react-router-dom';

export default function POSPage() {
  return <Navigate to="/pos" replace />;
}
