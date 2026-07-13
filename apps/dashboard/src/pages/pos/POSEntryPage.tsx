import { Routes, Route, Navigate } from 'react-router-dom';
import { usePOSAuth } from '../../context/POSAuthContext';
import POSLoginScreen from './POSLoginScreen';
import CashierScreen from './CashierScreen';

/**
 * POSEntryPage — Unified POS router
 *
 * /pos          → login screen (everyone uses this — owner, manager, cashier)
 * /pos/cashier  → POS terminal (requires active cashier session)
 */
export default function POSEntryPage() {
  const { session } = usePOSAuth();

  return (
    <Routes>
      <Route path="/" element={<POSLoginScreen />} />
      <Route
        path="/cashier"
        element={session ? <CashierScreen /> : <Navigate to="/pos" replace />}
      />
      <Route path="*" element={<Navigate to="/pos" replace />} />
    </Routes>
  );
}
