import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  define: {
    // Allows the portal to read VITE_API_URL from .env
    // 0.6.28: which build this is — the commit Vercel built (as the dashboard's A281 stamp); 'dev' locally.
    __WEB_BUILD_SHA__: JSON.stringify((process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev'),
  },
});
