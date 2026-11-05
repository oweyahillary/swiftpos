import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// The app's own screens (mode choice, the Stage 0 placeholders, updates, Reset app), bundled into the APK (webDir dist).
// Later stages load the shared web screens (packages/ui and the dashboard) rather than copying them.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
