import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: '/autoposter-dashboard/',
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'public/autoposter-dashboard',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./dashboard.html', import.meta.url))
    }
  }
});
