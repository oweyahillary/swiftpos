import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build tuned for a small initial payload:
//  - route-level React.lazy (in App.tsx) makes each page its own chunk
//  - manualChunks keeps stable vendors (react, recharts, supabase) in their own
//    long-cached files so a code change doesn't force re-downloading them
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('recharts') || id.includes('/d3-') || id.includes('victory') || id.includes('/d3/')) {
              return 'charts';           // heavy, only used by reports/cockpit
            }
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
