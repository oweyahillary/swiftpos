/**
 * App.tsx — root routing with a single AuthProvider.
 *
 * Before: AuthProvider was mounted three times (once per route group).
 * Navigating between /pos, /manager, and /dashboard destroyed and
 * recreated the entire context tree — causing full reloads, stale data,
 * and three competing Supabase onAuthStateChange subscriptions.
 *
 * After: AuthProvider wraps the BrowserRouter once. All routes share
 * a single Supabase session. BusinessProvider, BranchProvider, and
 * PermissionsProvider are also hoisted so they survive route transitions.
 *
 * POS and Manager routes get POSAuthProvider for the cashier PIN session.
 * The owner dashboard gets PermissionsProvider (owner-only).
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider }        from './context/AuthContext';
import { BusinessProvider }    from './context/BusinessContext';
import { BranchProvider }      from './context/BranchContext';
import { PermissionsProvider } from './context/PermissionsContext';
import { POSAuthProvider }     from './context/POSAuthContext';
import ErrorBoundary           from './components/ErrorBoundary';

import LoginPage               from './pages/LoginPage';
import OnboardingPage          from './pages/OnboardingPage';
import ForcePasswordChangePage from './pages/ForcePasswordChangePage';
import OverviewPage            from './pages/OverviewPage';
import CategoriesPage          from './pages/products/CategoriesPage';
import ProductsPage            from './pages/products/ProductsPage';
import POSPage                 from './pages/pos/POSPage';
import POSEntryPage            from './pages/pos/POSEntryPage';
import ManagerDashboard        from './pages/manager/ManagerDashboard';
import InventoryPage           from './pages/inventory/InventoryPage';
import SettingsPage            from './pages/SettingsPage';
import ReportsPage             from './pages/ReportsPage';
import KDSPage                 from './pages/kds/KDSPage';
import CustomersPage           from './pages/crm/CustomersPage';
import CreditAccountsPage      from './pages/customers/CreditAccountsPage';
import TableTurnoverPage       from './pages/pos/TableTurnoverPage';
import DiscountsPage           from './pages/DiscountsPage';
import PromotionsPage          from './pages/PromotionsPage';
import CombosPage              from './pages/products/CombosPage';
import ReservationsPage        from './pages/ReservationsPage';
import QRMenuPage              from './pages/QRMenuPage';
import BranchesPage            from './pages/BranchesPage';
import BranchDetailPage        from './pages/BranchDetailPage';
import SuppliersPage           from './pages/stock/SuppliersPage';
import PurchaseOrdersPage      from './pages/stock/PurchaseOrdersPage';
import StockTransfersPage      from './pages/stock/StockTransfersPage';
import IngredientsPage         from './pages/stock/IngredientsPage';
import PrintersPage            from './pages/settings/PrintersPage';
import ExpensesPage            from './pages/expenses/ExpensesPage';
import MinimartSettingsPage    from './pages/settings/MinimartSettingsPage';
import ParkingSettingsPage     from './pages/settings/ParkingSettingsPage';
import PetrolSettingsPage      from './pages/settings/PetrolSettingsPage';
import EtimsSettingsPage       from './pages/settings/EtimsSettingsPage';
import RestaurantSettingsPage  from './pages/settings/RestaurantSettingsPage';
import DashboardLayout         from './components/DashboardLayout';
import ProtectedRoute          from './components/ProtectedRoute';

export default function App() {
  return (
    /**
     * Single AuthProvider at the root — one Supabase subscription,
     * shared by every route. BusinessProvider and BranchProvider are
     * also at root so they survive navigation between /pos and /dashboard
     * without discarding already-loaded data.
     */
    <AuthProvider>
      <BusinessProvider>
        <BranchProvider>
          <BrowserRouter>
            <Routes>

              {/* ── Public routes (no auth) ─────────────────────────── */}
              <Route path="/kds"         element={<KDSPage />} />
              <Route path="/menu/:slug"  element={<QRMenuPage />} />

              {/* ── POS surface — cashier PIN auth ──────────────────── */}
              {/* POSAuthProvider scoped here: cashier session only     */}
              {/* lives for the lifetime of the POS tab.                */}
              <Route path="/pos/*" element={
                <POSAuthProvider>
                  <POSEntryPage />
                </POSAuthProvider>
              } />

              {/* ── Manager surface — PIN auth ───────────────────────── */}
              <Route path="/manager" element={
                <POSAuthProvider>
                  <ManagerDashboard />
                </POSAuthProvider>
              } />

              {/* ── Owner dashboard — Supabase session ──────────────── */}
              {/* PermissionsProvider is owner-only so scoped here.     */}
              <Route path="*" element={
                <ErrorBoundary>
                  <PermissionsProvider>
                  <Routes>
                    <Route path="/login"           element={<LoginPage />} />
                    <Route path="/onboarding"      element={<ProtectedRoute><OnboardingPage /></ProtectedRoute>} />
                    <Route path="/change-password" element={<ProtectedRoute><ForcePasswordChangePage /></ProtectedRoute>} />

                    <Route path="/dashboard" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
                      <Route index                             element={<OverviewPage />} />
                      <Route path="categories"                element={<CategoriesPage />} />
                      <Route path="products"                  element={<ProductsPage />} />
                      <Route path="pos"                       element={<POSPage />} />
                      <Route path="inventory"                 element={<InventoryPage />} />
                      <Route path="reports"                   element={<ReportsPage />} />
                      <Route path="customers"                 element={<CustomersPage currency="KES" />} />
                      <Route path="customers/credit"          element={<CreditAccountsPage />} />
                      <Route path="turnover"                  element={<TableTurnoverPage />} />
                      <Route path="discounts"                 element={<DiscountsPage />} />
                      <Route path="promotions"                element={<PromotionsPage />} />
                      <Route path="combos"                    element={<CombosPage />} />
                      <Route path="reservations"              element={<ReservationsPage />} />
                      <Route path="expenses"                  element={<ExpensesPage />} />
                      <Route path="branches"                  element={<BranchesPage />} />
                      <Route path="branches/:id"              element={<BranchDetailPage />} />
                      <Route path="settings"                  element={<SettingsPage />} />
                      <Route path="settings/restaurant"       element={<RestaurantSettingsPage />} />
                      <Route path="settings/minimart"         element={<MinimartSettingsPage />} />
                      <Route path="settings/parking"          element={<ParkingSettingsPage />} />
                      <Route path="settings/petrol"           element={<PetrolSettingsPage />} />
                      <Route path="settings/etims"            element={<EtimsSettingsPage />} />
                      <Route path="printers"                  element={<PrintersPage />} />
                      <Route path="stock/ingredients"         element={<IngredientsPage />} />
                      <Route path="stock/purchase-orders"     element={<PurchaseOrdersPage />} />
                      <Route path="stock/transfers"           element={<StockTransfersPage />} />
                      <Route path="stock/suppliers"           element={<SuppliersPage />} />
                    </Route>

                    <Route path="*" element={<Navigate to="/login" replace />} />
                  </Routes>
                </PermissionsProvider>
                </ErrorBoundary>
              } />

            </Routes>
          </BrowserRouter>
        </BranchProvider>
      </BusinessProvider>
    </AuthProvider>
  );
}
