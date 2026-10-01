import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

// Root js/ + assets/ are referenced by PLAIN URL (no bundler import): the
// string 'assets/bear.svg' sits in 10+ runtime templates (js/app.js, ui.js,
// theme.js) and e2e specs do import('/js/state.js') directly inside the page
// (16 call sites across 17-max-amount, 19-security-center, 21-account-switcher).
// publicDir only carries public/ (vendor), so dist/ shipped without them —
// CI 36930970112: every bear <img> was a 404 (console-error gate + 'brand
// image has no pixels') and every spec page-import died with 'Failed to fetch
// dynamically imported module'. Copy verbatim at build end; root js/ and
// assets/ stay the single source (no mirrored copies in the repo).
const copyLegacyStatic = {
  name: 'copy-legacy-static',
  closeBundle() {
    if (existsSync('assets')) cpSync('assets', 'dist/assets', { recursive: true });
    mkdirSync('dist/js', { recursive: true });
    for (const f of readdirSync('js')) {
      if (f.endsWith('.js')) copyFileSync(`js/${f}`, `dist/js/${f}`);
    }
  },
};

// Bear Tool — Vite config.
// base './' → relative asset URLs so dist/ works from any path (Capacitor
// webview, pages subpath, file servers). Vendor UMD scripts stay classic
// <script src> in index.html and are copied via publicDir (public/js/vendor).
export default defineConfig({
  base: './',
  plugins: [react(), copyLegacyStatic],
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
