/**
 * OwnerPhoneScreens — the ZapTill dashboard as the Android app's owner / manager phone opens it (Owner stage A,
 * docs/designs/ANDROID-APP-DESIGN.md). The dashboard's OWN App — sign-in, overview, reports, analytics, everything — loaded
 * here, NOT copied (one dashboard, the same rule as the one-POS Shop POS). The Android app points it at its API
 * (window.__SWIFTPOS_CONFIG__ → dev-api, apps/android/src/main.tsx) and wears the native shell; owner sign-in is Supabase,
 * exactly as on the web (apps/android/vite.config.ts gives this bundle the real Supabase client — not the Shop POS stub).
 *
 * The ONE way in from apps/android (its vite.config.ts maps '@zaptill/dashboard-owner' here).
 */
import { ThemeProvider } from '../context/ThemeContext';
import App from '../App';
import { bootBrandTheme } from '../lib/themeBoot';
import '../index.css';

bootBrandTheme();   // the business's last look (colours + logo) before the first paint, as the web dashboard does

/** The whole dashboard — its AuthProvider gates on the owner's Supabase sign-in, then its own BrowserRouter runs overview,
 *  reports, analytics and the rest. Mounted by the owner-phone mode (apps/android screens/OwnerPhone.tsx). */
export function OwnerDashboard() {
  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}
