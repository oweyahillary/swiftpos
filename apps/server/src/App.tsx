import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { BusinessProvider } from './context/BusinessContext';
import ProtectedRoute from './components/ProtectedRoute';
import DashboardLayout from './components/DashboardLayout';
import LoginPage from './pages/LoginPage';
import OnboardingPage from './pages/OnboardingPage';
import OverviewPage from './pages/OverviewPage';
import CategoriesPage from './pages/products/CategoriesPage';
import ProductsPage from './pages/products/ProductsPage';
import POSPage from './pages/pos/POSPage';
import InventoryPage from './pages/inventory/InventoryPage';
import KDSPage from './pages/kds/KDSPage';

export default function App() {
  return (
    <AuthProvider>
      <BusinessProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/onboarding" element={<ProtectedRoute><OnboardingPage /></ProtectedRoute>} />
            <Route path="/dashboard" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
              <Route index element={<OverviewPage />} />
              <Route path="categories" element={<CategoriesPage />} />
              <Route path="products" element={<ProductsPage />} />
              <Route path="pos" element={<POSPage />} />
              <Route path="inventory" element={<InventoryPage />} />
            </Route>
            <Route path="/kds" element={<KDSPage />} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </BrowserRouter>
      </BusinessProvider>
    </AuthProvider>
  );
}
