import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./shared/', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: {
    outDir: 'local-site',
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve('index.html'), main: resolve('main/index.html'), whiteboard: resolve('whiteboard/index.html') } },
  },
  server: { host: '127.0.0.1' },
});
