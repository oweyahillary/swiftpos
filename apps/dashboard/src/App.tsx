/**
 * App.tsx — root routing with a single AuthProvider.
 *
 * Providers + layout are eager (needed for the shell); every PAGE is loaded
 * lazily via React.lazy so each route ships as its own chunk. A visitor to /pos
 * downloads only the POS chunk — not the owner dashboard, reports, or recharts.
 */

import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider }        from './context/AuthContext';
import { BusinessProvider }    from './context/BusinessContext';
import { BranchProvider }      from './context/BranchContext';
import { PermissionsProvider } from './context/PermissionsContext';
import { POSAuthProvider }     from './context/POSAuthContext';
import ErrorBoundary           from './components/ErrorBoundary';
import ProtectedRoute          from './components/ProtectedRoute';

// ── Lazily-loaded pages (each becomes its own on-demand chunk) ───────────────
const LoginPage               = lazy(() => import('./pages/LoginPage'));
const OnboardingPage          = lazy(() => import('./pages/OnboardingPage'));
const ForcePasswordChangePage = lazy(() => import('./pages/ForcePasswordChangePage'));
const OverviewPage            = lazy(() => import('./pages/OverviewPage'));
const CategoriesPage          = lazy(() => import('./pages/products/CategoriesPage'));
const ProductsPage            = lazy(() => import('./pages/products/ProductsPage'));
const POSPage                 = lazy(() => import('./pages/pos/POSPage'));
const POSEntryPage            = lazy(() => import('./pages/pos/POSEntryPage'));
const ManagerDashboard        = lazy(() => import('./pages/manager/ManagerDashboard'));
const InventoryPage           = lazy(() => import('./pages/inventory/InventoryPage'));
const SettingsPage            = lazy(() => import('./pages/SettingsPage'));
const ReportsPage             = lazy(() => import('./pages/ReportsPage'));
const KDSPage                 = lazy(() => import('./pages/kds/KDSPage'));
const CustomersPage           = lazy(() => import('./pages/crm/CustomersPage'));
const CreditAccountsPage      = lazy(() => import('./pages/customers/CreditAccountsPage'));
const TableTurnoverPage       = lazy(() => import('./pages/pos/TableTurnoverPage'));
const DiscountsPage           = lazy(() => import('./pages/DiscountsPage'));
const PromotionsPage          = lazy(() => import('./pages/PromotionsPage'));
const CombosPage              = lazy(() => import('./pages/products/CombosPage'));
const ReservationsPage        = lazy(() => import('./pages/ReservationsPage'));
const QRMenuPage              = lazy(() => import('./pages/QRMenuPage'));
const BranchesPage            = lazy(() => import('./pages/BranchesPage'));
const BranchDetailPage        = lazy(() => import('./pages/BranchDetailPage'));
const SuppliersPage           = lazy(() => import('./pages/stock/SuppliersPage'));
const PurchaseOrdersPage      = lazy(() => import('./pages/stock/PurchaseOrdersPage'));
const StockTransfersPage      = lazy(() => import('./pages/stock/StockTransfersPage'));
const IngredientsPage         = lazy(() => import('./pages/stock/IngredientsPage'));
const PrintersPage            = lazy(() => import('./pages/settings/PrintersPage'));
const ExpensesPage            = lazy(() => import('./pages/expenses/ExpensesPage'));
const MinimartSettingsPage    = lazy(() => import('./pages/settings/MinimartSettingsPage'));
const ParkingSettingsPage     = lazy(() => import('./pages/settings/ParkingSettingsPage'));
const PetrolSettingsPage      = lazy(() => import('./pages/settings/PetrolSettingsPage'));
const EtimsSettingsPage       = lazy(() => import('./pages/settings/EtimsSettingsPage'));
const RestaurantSettingsPage  = lazy(() => import('./pages/settings/RestaurantSettingsPage'));
const DashboardLayout         = lazy(() => import('./components/DashboardLayout'));

function PageLoader() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#0a0f1a', color: '#64748b',
      fontSize: 14, fontFamily: 'system-ui, sans-serif',
    }}>
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BusinessProvider>
        <BranchProvider>
          <BrowserRouter>
            <Suspense fallback={<PageLoader />}>
            <Routes>

              {/* ── Public routes (no auth) ─────────────────────────── */}
              <Route path="/kds"         element={<KDSPage />} />
              <Route path="/menu/:slug"  element={<QRMenuPage />} />

              {/* ── POS surface — cashier PIN auth ──────────────────── */}
              <Route path="/pos/*" element={
                <ErrorBoundary>
                  <POSAuthProvider>
                    <POSEntryPage />
                  </POSAuthProvider>
                </ErrorBoundary>
              } />

              {/* ── Manager surface — PIN auth ───────────────────────── */}
              <Route path="/manager" element={
                <ErrorBoundary>
                  <POSAuthProvider>
                    <ManagerDashboard />
                  </POSAuthProvider>
                </ErrorBoundary>
              } />

              {/* ── Owner dashboard — Supabase session ──────────────── */}
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
            </Suspense>
          </BrowserRouter>
        </BranchProvider>
      </BusinessProvider>
    </AuthProvider>
  );
}
