/**
 * config.ts — runtime configuration for the dashboard.
 *
 * Problem: VITE_API_URL is baked into the JS bundle at build time.
 * For cloud deployments this is fine. For offline/local-server installs
 * (Decision D4), the dashboard must point at the local server without
 * a rebuild.
 *
 * Solution: read from window.__SWIFTPOS_CONFIG__ at runtime first,
 * fall back to the compile-time VITE_API_URL, then localhost.
 *
 * For offline installs, inject the config into index.html at deploy time:
 *   <script>
 *     window.__SWIFTPOS_CONFIG__ = { apiUrl: "http://192.168.1.100:4000" };
 *   </script>
 *
 * This approach (runtime injection) is standard for containerised SaaS apps
 * that serve one build to many environments.
 */

declare global {
  interface Window {
    __SWIFTPOS_CONFIG__?: {
      apiUrl?: string;
      /** Owner, 2026-11-22: true when this dashboard runs INSIDE the Android app (owner / manager phone mode) — set by
       *  apps/android/src/main.tsx. Lets the dashboard apply phone-only rules (e.g. who sees the "Open POS" shortcut). */
      native?: boolean;
    };
  }
}

/** Owner, 2026-11-22: is this dashboard running inside the Android owner / manager phone app (not a web browser)? */
export function isNativeApp(): boolean {
  try { return window.__SWIFTPOS_CONFIG__?.native === true; } catch { return false; }
}

function resolveApiUrl(): string {
  // 1. Runtime injection (offline installs, Docker, multi-env deploys). Guarded so this module is safe to load outside a
  //    browser (Node / react-dom/server — e.g. the sidebar render tests bundle this via isNativeApp).
  const runtimeUrl = typeof window !== 'undefined' ? window.__SWIFTPOS_CONFIG__?.apiUrl : undefined;
  if (runtimeUrl) return runtimeUrl.replace(/\/$/, ''); // strip trailing slash

  // 2. Compile-time env var (standard cloud deploy). `import.meta.env` is Vite's — undefined in a plain Node bundle, so
  //    read it optionally (same reason as the window guard above).
  const buildUrl = import.meta.env?.VITE_API_URL as string | undefined;
  if (buildUrl) return buildUrl.replace(/\/$/, '');

  // 3. Local development fallback
  return 'http://localhost:4000';
}

export const API_URL = resolveApiUrl();
