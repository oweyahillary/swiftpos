/**
 * OwnerPhone — the owner / manager phone mode (Owner stage A, docs/designs/ANDROID-APP-DESIGN.md). It opens the ZapTill
 * dashboard itself — sign in and see today's sales, reports, overview and analytics, by branch, from anywhere — loaded from
 * the dashboard (@zaptill/dashboard-owner → apps/dashboard ownerPhone/OwnerPhoneScreens.tsx), pointed at this app's API
 * (window.__SWIFTPOS_CONFIG__ → dev-api, src/main.tsx). The dashboard owns its own routing and owner sign-in (Supabase)
 * from here; the native shell only hosts it.
 */
import { lazy, Suspense, useState } from 'react';

const OwnerDashboard = lazy(() => import('@zaptill/dashboard-owner').then((m) => ({ default: m.OwnerDashboard })));

export default function OwnerPhone(_props: { version: string; onReset: () => Promise<void> }) {
  // Start the dashboard's router at the root once, so a path left over from a previous screen never lands on a 404 (the
  // dashboard redirects unknown paths to sign-in / overview anyway; this just keeps the first paint clean).
  useState(() => { if (window.location.pathname !== '/') window.history.replaceState(null, '', '/'); return null; });
  return (
    <Suspense fallback={<main className="screen centre"><p className="note">Opening ZapTill…</p></main>}>
      <OwnerDashboard />
    </Suspense>
  );
}
