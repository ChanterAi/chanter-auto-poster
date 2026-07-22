import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

function deterministicHtmlOutput() {
  return {
    name: 'chanter-deterministic-html-output',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset' || !output.fileName.endsWith('.html')) continue;
        const source = Buffer.isBuffer(output.source)
          ? output.source.toString('utf8')
          : String(output.source);
        output.source = source
          .replace(/\r\n?/g, '\n')
          .replace(/[ \t]+$/gm, '');
      }
    }
  };
}

export default defineConfig({
  base: '/autoposter-dashboard/',
  plugins: [react(), deterministicHtmlOutput()],
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
