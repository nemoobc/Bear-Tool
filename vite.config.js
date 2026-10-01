import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bear Tool — Vite config.
// base './' → relative asset URLs so dist/ works from any path (Capacitor
// webview, pages subpath, file servers). Vendor UMD scripts stay classic
// <script src> in index.html and are copied via publicDir (public/js/vendor).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: true,
    port: 5173,
  },
});
