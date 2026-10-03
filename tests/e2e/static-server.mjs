/**
 * Static file server for the E2E suite, serving the REAL production artifact from
 * `apps/web/dist` behind the REAL gateway security headers.
 *
 * WHY serve `dist/` and not the Vite dev server: the artifact under test is the prerendered HTML
 * plus the built bundle. That is what visitors get and what the CSP governs. Testing against a dev
 * server would prove the wrong thing -- dev serves a Fast Refresh preamble and no CSP at all, so a
 * dev-only test cannot detect the failure that actually matters (the production CSP blocking the
 * production bundle).
 *
 * WHY import `securityHeaders` from the gateway instead of copying the header set: a duplicated CSP
 * is a second source of truth that drifts. If the gateway tightens the policy, these tests pick it
 * up automatically, and a policy that only the test server enforces would be worthless.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from '../../services/gateway/src/middleware/security.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'apps', 'web', 'dist');

/** The minimal shape `securityHeaders(config)` reads. Mirrors loadConfig()'s local defaults. */
const CONFIG = Object.freeze({
  appEnv: 'local',
  allowAnyHttpsEndpoint: false,
  cspScriptSrc: "'self'",
  cspStyleSrc: "'self'",
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Resolves a URL path to a file inside DIST, or null when it escapes.
 *
 * WHY the containment check: `normalize` alone does not stop `/../../.env`. The resolved path is
 * compared against the DIST prefix so a traversal attempt returns null instead of a 200. This
 * server exists only for tests, but a fixture server that can be walked out of is a bad example.
 */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(clean).replace(/^([/\\])+/, '');
  const target = resolve(DIST, rel === '' ? 'index.html' : rel);
  if (target !== DIST && !target.startsWith(DIST + sep)) return null;
  if (existsSync(target) && statSync(target).isFile()) return target;
  // Directory-style URL, e.g. "/" already handled; anything else is a genuine 404.
  return null;
}

/**
 * The gateway this server proxies /api to.
 *
 * WHY a proxy at all: the page calls `/api/v1/chat/stream` on its own origin. The CSP `connect-src`
 * permits this site's own origin, and a relative URL satisfies it without a cross-origin request.
 * Proxying (rather than pointing fetch at :8082 directly) is what keeps the no-CORS path working and
 * keeps the gateway's own CORS policy out of the browser's way during E2E.
 */
const GATEWAY = process.env.E2E_GATEWAY ?? 'http://127.0.0.1:8082';

export function createStaticServer() {
  return createServer(async (req, res) => {
    const headers = securityHeaders(CONFIG);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    // --- API proxy -----------------------------------------------------------------------------
    // WHY before the static handler: /api paths are not files, so the static branch would 404 them.
    if (req.url?.startsWith('/api/')) {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        // WHY strip the /api prefix: the page calls `/api/v1/...` so that the request is same-origin
        // (CSP `connect-src 'self'` covers it and no CORS preflight is needed), but the gateway's real
        // routes are `/v1/...`. Forwarding the prefix verbatim produced a 404 from the gateway for
        // every single call -- the symptom being a chat panel stuck on its placeholder with no error.
        const upstreamPath = req.url.replace(/^\/api/, '');
        const upstream = await fetch(`${GATEWAY}${upstreamPath}`, {
          method: req.method,
          headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          // WHY no timeout here: SSE streams stay open for the length of a chat turn, and a short
          // client timeout would truncate every answer mid-sentence.
          duplex: 'half',
        });
        res.statusCode = upstream.status;
        upstream.headers.forEach((v, k) => {
          // WHY forward content-type but not content-encoding: fetch already decoded the body, so
          // forwarding a stale encoding header would make the browser fail to parse it.
          if (k === 'content-type' || k === 'cache-control') res.setHeader(k, v);
        });
        // WHY pipe instead of buffering: this endpoint is Server-Sent Events, and the upstream stream
        // stays OPEN for the length of a whole chat turn. An earlier version did
        // `await upstream.arrayBuffer()`, which waits for the stream to END -- so the proxy never
        // responded, and the browser sat looking at the panel's ellipsis placeholder forever. SSE
        // must be relayed byte-for-byte as it arrives; that is the entire point of it.
        if (upstream.body) {
          const { Readable } = await import('node:stream');
          Readable.fromWeb(upstream.body).pipe(res);
        } else {
          res.end();
        }
      } catch (err) {
        // WHY a real 502 rather than a hang: a missing gateway must surface as a failure the test can
        // read, not a request that never settles.
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'internal', message_safe: `proxy failed: ${err.message}` } }));
      }
      return;
    }

    const file = resolveFile(req.url ?? '/');
    if (!file) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const built = existsSync(join(DIST, 'index.html'));
      res.end(built
        ? '404 Not Found'
        // WHY a distinct message: a missing dist/index.html is the single most likely reason an
        // E2E run fails on a clean checkout, and a bare "404 Not Found" gives no clue at all.
        : `The site has not been built yet.\n\nRun: npm run build\n`
          + `Expected: ${join(DIST, 'index.html')}`);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
}

const invokedDirectly = process.argv[1]?.endsWith('static-server.mjs');
if (invokedDirectly) {
  const port = Number(process.env.E2E_PORT ?? 4173);
  createStaticServer().listen(port, '127.0.0.1', () => {
    console.log(`[e2e-server] serving ${DIST} on http://127.0.0.1:${port}`);
    console.log(`[e2e-server] CSP: ${securityHeaders(CONFIG)['Content-Security-Policy']}`);
  });
}