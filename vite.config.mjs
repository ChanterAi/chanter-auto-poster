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
      input: {
        dashboard: fileURLToPath(new URL('./dashboard.html', import.meta.url)),
        'prompt-evolver-main': fileURLToPath(new URL('./src/prompt-evolver-main.jsx', import.meta.url))
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
