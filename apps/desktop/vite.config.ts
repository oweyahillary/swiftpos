import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Shared components step 3: @zaptill/ui (linked, no node_modules of its own) resolves react and @zaptill/core from this
  // app's node_modules — one React, never two.
  resolve: { preserveSymlinks: true },
  build: { outDir: 'dist/renderer' },
  server: { port: 5174 },
});
