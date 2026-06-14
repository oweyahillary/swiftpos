import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
  define: {
    // Allows the portal to read VITE_API_URL from .env
  },
});
