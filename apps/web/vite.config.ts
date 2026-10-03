import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));

/**
 * Serves the PYTHON-GENERATED site during development.
 *
 * WHY this plugin exists: `npm run dev` must show the real artifact, and Vite's dev server looks for
 * an `index.html` in its own root. There isn't one -- `scripts/build_static_site.py` owns it and
 * writes it to `dist/`. Without this, `npm run dev` served a bare 404 while every other service came
 * up fine, which reads as "the front end is broken" when actually nothing had been wired.
 *
 * WHY this is a dev-only plugin and not the build path: the build already emits only `main.js` into
 * `dist/assets`. This exists purely so the dev server can render the same HTML the build produces.
 *
 * WHY the script tag is rewritten: the generated HTML references the BUILT bundle at
 * `/assets/main.js`. In dev that file is either stale or absent, so requests for it would load
 * yesterday's code. Repointing it at `/src/main.tsx` gives live transforms and HMR.
 */
function generatedSite(): Plugin {
  return {
    name: 'portfolio-generated-site',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (
        req: IncomingMessage,
        res: ServerResponse,
        next: (err?: unknown) => void,
      ) => {
        const url = (req.url ?? '/').split('?')[0];

        if (url === '/' || url === '/index.html') {
          const indexPath = `${DIST}/index.html`;
          if (!existsSync(indexPath)) {
            // WHY a named instruction instead of a 404: this is the single most confusing failure in
            // the dev loop, and the fix is one command that is not otherwise discoverable.
            res.statusCode = 503;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(
              'The site has not been generated yet.\n\n'
              + 'Run:  npm run build:site\n\n'
              + 'It writes dist/index.html and dist/assets/site.css from content/profile.json.\n',
            );
            return;
          }
          const html = readFileSync(indexPath, 'utf8')
            .replace('/assets/main.js', '/src/main.tsx');
          // WHY transformIndexHtml: it injects Vite's HMR client. Writing raw HTML with res.end
          // would serve a page with no HMR, which looks like the dev server not working.
          const transformed = await server.transformIndexHtml(url, html);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(transformed);
          return;
        }

        // The generated HTML references /assets/site.css and /resume/*.pdf, both of which live in
        // dist rather than in Vite's root. Serve them so the page is not missing its styles.
        for (const prefix of ['/assets/', '/resume/']) {
          if (!url.startsWith(prefix)) continue;
          const rel = url.slice(1).split('/').join('/');
          const file = `${DIST}/${rel}`;
          // WHY the traversal guard: the URL is attacker-influenced. Without it, `../../.env` would
          // be read out of dist and served. Resolve and confirm the result is still inside DIST.
          if (!file.startsWith(DIST) || !existsSync(file)) break;
          res.setHeader('Content-Type', rel.endsWith('.pdf') ? 'application/pdf' : 'text/css');
          res.end(readFileSync(file));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [generatedSite(), react(), tailwindcss()],
  // WHY false: the resume PDF is copied by build_static_site.py into dist/resume/. Letting Vite
  // also copy public/ would duplicate it inside the JS output directory on every build.
  publicDir: false,
  server: {
    // WHY localhost rather than 127.0.0.1: SITE_ORIGIN in .env.example is
    // http://localhost:5173, and on Windows an explicit 127.0.0.1 binds only the IPv4 loopback while
    // browsers resolve localhost to ::1 first. Pinning the name keeps both the CSP origin and the
    // reachable address in agreement instead of depending on Vite's default.
    host: 'localhost',
    port: 5173,
    // WHY strictPort: Vite's default is to silently fall back to 5174. Every other service in this
    // project is bound to a fixed port and SITE_ORIGIN names it, so a silent move breaks CORS for
    // the gateway with no error anywhere.
    strictPort: true,
    proxy: {
      // The gateway. Kept here so the browser needs no CORS preflight in dev.
      '/api': { target: 'http://localhost:8082', changeOrigin: true },
    },
  },
  build: {
    // WHY './dist/assets' and not '../dist/assets': a relative URL in this file resolves against
    // the FILE's own directory (apps/web/), so '../dist' would land in apps/dist and silently emit
    // the bundle outside the served tree.
    outDir: fileURLToPath(new URL('./dist/assets', import.meta.url)),
    // WHY this is load-bearing: the Python generator's index.html and site.css live in this same
    // directory. Vite's default is to empty it, which would delete the prerendered artifact and
    // silently break both SEO and the no-JS path.
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      output: {
        format: 'es',
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});