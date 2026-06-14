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
    };
  }
}

function resolveApiUrl(): string {
  // 1. Runtime injection (offline installs, Docker, multi-env deploys)
  const runtimeUrl = window.__SWIFTPOS_CONFIG__?.apiUrl;
  if (runtimeUrl) return runtimeUrl.replace(/\/$/, ''); // strip trailing slash

  // 2. Compile-time env var (standard cloud deploy)
  const buildUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (buildUrl) return buildUrl.replace(/\/$/, '');

  // 3. Local development fallback
  return 'http://localhost:4000';
}

export const API_URL = resolveApiUrl();
