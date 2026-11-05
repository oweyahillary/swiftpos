import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SRC = path.resolve(HERE, '../dashboard/src');
/** Till stage 1: the web POS screens, entered through ONE dashboard file (docs/ANDROID-APP-DESIGN.md §11.1). */
const SHOP_POS_ENTRY = path.join(DASHBOARD_SRC, 'shopPos/ShopPosScreens.tsx');
/** The dashboard's Supabase client is for the owner's web sign-in, never a Shop POS (its sign-in is its own, A415). */
const SUPABASE_CLIENT = path.join(DASHBOARD_SRC, 'lib/supabase');
const SUPABASE_STUB = path.resolve(HERE, 'src/shop/supabaseStub.ts');

const isBare = (s: string) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('\0') && !path.isAbsolute(s);
const inDashboard = (file: string | undefined) => !!file && path.resolve(file.split('?')[0]).startsWith(DASHBOARD_SRC);

/**
 * The web POS screens are the dashboard's own files, bundled here — shared, not copied (owner, 2026-11-04: one POS
 * design). Their packages (react, react-router-dom, @zaptill/core, @zaptill/ui …) resolve from THIS app's node_modules, so
 * there is one React and the APK builds without the dashboard's packages installed. The Supabase client is swapped for a
 * stub that never signs anyone in.
 */
function webPosScreens(): Plugin {
  return {
    name: 'zaptill-web-pos-screens',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source === '@zaptill/dashboard-pos') return SHOP_POS_ENTRY;
      if (!inDashboard(importer)) return null;
      if (isBare(source)) return this.resolve(source, path.join(HERE, 'src/main.tsx'), { ...options, skipSelf: true });
      const target = path.resolve(path.dirname(importer!.split('?')[0]), source).replace(/\.ts$/, '');
      return target === SUPABASE_CLIENT ? SUPABASE_STUB : null;
    },
  };
}

// The app's own screens (mode choice, joining, the PIN pad, updates, Reset app) and, for a Shop POS, the web POS screens.
export default defineConfig({
  plugins: [webPosScreens(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // What the dashboard's build stamps (its vite.config.ts); the APK's own version says the rest.
    __WEB_BUILD_SHA__: JSON.stringify('android'),
    __WEB_BUILD_REF__: JSON.stringify(`android-${pkg.version}`),
    __WEB_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Absolute: the Shop POS's screens live under /pos/… (the web POS's own paths), and a reload there must still find the
  // bundle. Capacitor serves the app from the root of https://localhost.
  base: '/',
  // @zaptill/ui is linked (file:) — its imports resolve from this app's node_modules, as in the dashboard.
  resolve: { preserveSymlinks: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 900 },
});
