/**
 * ShopPosScreens — the web POS screens as the ZapTill Android app's Shop POS opens them (Till stage 1,
 * docs/ANDROID-APP-DESIGN.md §11). The ONE way in from apps/android (its vite.config.ts maps '@zaptill/dashboard-pos'
 * here): the screens are the dashboard's own — CashierScreen and everything it opens (payment, split payments, the
 * after-payment screen, shifts with declared amounts and blind close, held orders, delivery and rider, discounts, kitchen
 * voids) — never copied (owner, 2026-11-04: one POS design, the desktop as its base).
 *
 * The Android app keeps what is its own: joining, the POS's own session in the Keystore, the PIN pad (POST
 * /api/auth/verify-pin with that session), printing to the network printers, and "No connection — can't sell". It hands
 * the signed-in person's session here (storeCashierSession) and tells these screens which POS they run on (setShopPosHost).
 */
import { ThemeProvider } from '../context/ThemeContext';
import { AuthProvider } from '../context/AuthContext';
import { BusinessProvider } from '../context/BusinessContext';
import { Navigate } from 'react-router-dom';
import { POSAuthProvider, usePOSAuth } from '../context/POSAuthContext';
import CashierScreen from '../pages/pos/CashierScreen';
import { bootBrandTheme } from '../lib/themeBoot';
import '../index.css';

export { setShopPosHost } from '../lib/shopPos';
export { storeCashierSession } from '../context/POSAuthContext';

bootBrandTheme();   // A609: the shop's last look (colours + menu logo), as the web dashboard does at start

/**
 * The selling screen for the person signed in with their PIN. Mounted afresh at each sign-in, so the POS session is read
 * from where storeCashierSession put it; locking (CashierScreen) returns to the app's PIN pad at /pos.
 */
export function ShopPosSelling() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BusinessProvider>
          <POSAuthProvider>
            <SignedIn />
          </POSAuthProvider>
        </BusinessProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

/** As the web's POSEntryPage: no session (it expired, or the person locked) → back to the PIN pad. */
function SignedIn() {
  const { session } = usePOSAuth();
  return session ? <CashierScreen /> : <Navigate to="/pos" replace />;
}
