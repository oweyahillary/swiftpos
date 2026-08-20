/**
 * App.tsx — root routing with a single AuthProvider.
 *
 * Providers + layout are eager (needed for the shell); every PAGE is loaded
 * lazily via React.lazy so each route ships as its own chunk. A visitor to /pos
 * downloads only the POS chunk — not the owner dashboard or reports.
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
import OpenShiftsPage         from './pages/OpenShiftsPage';
import FleetPage              from './pages/FleetPage';

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
// Settings › three sections (register A133). Container pages default-export;
// their child route wrappers are named exports pulled via the {default} shim so
// each still ships as its own lazy chunk.
const UsersAccessPage     = lazy(() => import('./pages/settings/UsersAccessPage'));
const StaffMembersRoute   = lazy(() => import('./pages/settings/UsersAccessPage').then(m => ({ default: m.StaffMembersRoute })));
const RolesRoute          = lazy(() => import('./pages/settings/UsersAccessPage').then(m => ({ default: m.RolesRoute })));
const DevicesPrintersPage = lazy(() => import('./pages/settings/DevicesPrintersPage'));
const DevicesRoute        = lazy(() => import('./pages/settings/DevicesPrintersPage').then(m => ({ default: m.DevicesRoute })));
const BusinessPage        = lazy(() => import('./pages/settings/BusinessPage'));
const VerticalSetupRoute  = lazy(() => import('./pages/settings/BusinessPage').then(m => ({ default: m.VerticalSetupRoute })));
const IntegrationsRoute   = lazy(() => import('./pages/settings/BusinessPage').then(m => ({ default: m.IntegrationsRoute })));
const ReportsPage             = lazy(() => import('./pages/ReportsPage'));
const KDSPage                 = lazy(() => import('./pages/kds/KDSPage'));
const CustomersPage           = lazy(() => import('./pages/crm/CustomersPage'));
const CreditAccountsPage      = lazy(() => import('./pages/customers/CreditAccountsPage'));
const TableTurnoverPage       = lazy(() => import('./pages/pos/TableTurnoverPage'));
const DiscountsPage           = lazy(() => import('./pages/DiscountsPage'));
const PaymentMethodsPage      = lazy(() => import('./pages/PaymentMethodsPage'));
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
const StationsPage            = lazy(() => import('./pages/settings/StationsPage'));
const ExpensesPage            = lazy(() => import('./pages/expenses/ExpensesPage'));
const EtimsSettingsPage       = lazy(() => import('./pages/settings/EtimsSettingsPage'));
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
                      <Route path="open-drawers"              element={<OpenShiftsPage />} />
                      <Route path="terminals"                 element={<Navigate to="/dashboard/settings/devices/terminals" replace />} />
                      <Route path="customers"                 element={<CustomersPage currency="KES" />} />
                      <Route path="customers/credit"          element={<CreditAccountsPage />} />
                      <Route path="turnover"                  element={<TableTurnoverPage />} />
                      <Route path="discounts"                 element={<DiscountsPage />} />
                      <Route path="payment-methods"           element={<Navigate to="/dashboard/settings/business/payments" replace />} />
                      <Route path="promotions"                element={<PromotionsPage />} />
                      <Route path="combos"                    element={<CombosPage />} />
                      <Route path="reservations"              element={<ReservationsPage />} />
                      <Route path="expenses"                  element={<ExpensesPage />} />
                      <Route path="branches"                  element={<Navigate to="/dashboard/settings/business/branches" replace />} />
                      <Route path="branches/:id"              element={<BranchDetailPage />} />
                      {/* ── Settings — three sections, each a tabbed page (A133) ── */}
                      <Route path="settings" element={<Navigate to="/dashboard/settings/users/staff" replace />} />

                      <Route path="settings/users" element={<UsersAccessPage />}>
                        <Route index          element={<Navigate to="staff" replace />} />
                        <Route path="staff"   element={<StaffMembersRoute />} />
                        <Route path="roles"   element={<RolesRoute />} />
                      </Route>

                      <Route path="settings/devices" element={<DevicesPrintersPage />}>
                        <Route index            element={<Navigate to="terminals" replace />} />
                        <Route path="terminals" element={<FleetPage />} />
                        <Route path="devices"   element={<DevicesRoute />} />
                        <Route path="printers"  element={<PrintersPage />} />
                        <Route path="stations"  element={<StationsPage />} />
                      </Route>

                      <Route path="settings/business" element={<BusinessPage />}>
                        <Route index               element={<Navigate to="branches" replace />} />
                        <Route path="branches"     element={<BranchesPage />} />
                        <Route path="tax"          element={<EtimsSettingsPage />} />
                        <Route path="payments"     element={<PaymentMethodsPage />} />
                        <Route path="setup"        element={<VerticalSetupRoute />} />
                        <Route path="integrations" element={<IntegrationsRoute />} />
                      </Route>

                      {/* back-compat: old deep links redirect into the new sections */}
                      <Route path="settings/restaurant" element={<Navigate to="/dashboard/settings/business/setup" replace />} />
                      <Route path="settings/minimart"   element={<Navigate to="/dashboard/settings/business/setup" replace />} />
                      <Route path="settings/parking"    element={<Navigate to="/dashboard/settings/business/setup" replace />} />
                      <Route path="settings/petrol"     element={<Navigate to="/dashboard/settings/business/setup" replace />} />
                      <Route path="settings/etims"      element={<Navigate to="/dashboard/settings/business/tax" replace />} />
                      <Route path="printers"            element={<Navigate to="/dashboard/settings/devices/printers" replace />} />
                      <Route path="stations"            element={<Navigate to="/dashboard/settings/devices/stations" replace />} />
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
