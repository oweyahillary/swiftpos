import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build tuned for a small initial payload:
//  - route-level React.lazy (in App.tsx) makes each page its own chunk
//  - manualChunks keeps stable vendors (react, recharts, supabase) in their own
//    long-cached files so a code change doesn't force re-downloading them
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // A281: stamp the web build with its commit so "is the front-end current?" is a
  // glance, not an investigation (the till-picker "missing" because Vercel served a
  // main build cost hours). Vercel exposes these at build; falls back for local.
  define: {
    __WEB_BUILD_SHA__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev'),
    __WEB_BUILD_REF__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_REF || 'local'),
    __WEB_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@supabase')) return 'supabase';
            if (id.includes('react-router')) return 'router';
            if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
              return 'react-vendor';
            }
            return 'vendor';
          }
        },
      },
    },
  },
});
