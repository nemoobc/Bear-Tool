import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Root js/ + assets/ are referenced by PLAIN URL (no bundler import): the
// string 'assets/bear.svg' sits in 10+ runtime templates (js/app.js, ui.js,
// theme.js) and e2e specs do import('/js/state.js') directly inside the page
// (16 call sites across 17-max-amount, 19-security-center, 21-account-switcher).
// publicDir only carries public/ (vendor), so dist/ shipped without them —
// CI 36930970112: every bear <img> was a 404 (console-error gate + 'brand
// image has no pixels') and every spec page-import died with 'Failed to fetch
// dynamically imported module'. Copy verbatim at build end; root js/ and
// assets/ stay the single source (no mirrored copies in the repo).
//
// RECURSION IS REQUIRED, not tidiness. The first version walked js/ with
// readdirSync and copied only top-level *.js — so js/dex/ (a DIRECTORY) was
// skipped and the ENTIRE Dex feature shipped missing from every APK: the app
// opened with no Dex at all, while GitHub Pages looked perfect, because Pages
// serves the source tree and only the APK runs this build. The two shipped
// targets disagreed for exactly that reason. Everything under js/ is copied
// now, whatever its depth or type.
const copyLegacyStatic = {
  name: 'copy-legacy-static',
  closeBundle() {
    if (existsSync('assets')) cpSync('assets', 'dist/assets', { recursive: true });
    // css/ was missing here too, and for the same reason js/dex/ was: the copy
    // step listed assets and js only, so index.html's <link href="css/…"> 404'd
    // inside every APK and the app shipped completely unstyled. GitHub Pages
    // never noticed because it serves the source tree.
    if (existsSync('css')) cpSync('css', 'dist/css', { recursive: true, force: true });
    // dest/js already exists by this point: Vite's own publicDir pass copies
    // public/js/vendor there first. cpSync('js', 'dist/js', {recursive}) merges
    // a directory into an existing one and throws EEXIST on this Node, even with
    // force — so each top-level entry is copied on its own, recursively. Files
    // AND directories: that is the whole point, since js/dex/ is a directory.
    mkdirSync('dist/js', { recursive: true });
    for (const entry of readdirSync('js')) {
      // vendor is skipped deliberately: public/js/vendor and js/vendor are the
      // same directory, and Vite's publicDir pass has already copied it by now.
      // Copying it again died with "EEXIST: symlink public/js/vendor".
      if (entry === 'vendor') continue;
      cpSync(join('js', entry), join('dist/js', entry), { recursive: true, force: true });
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
