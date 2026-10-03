import express from 'express';
import { describe, expect, it, afterEach } from 'vitest';

/**
 * WHY these tests exist: middleware ORDER is invisible when reading either file alone, and only
 * shows up as behaviour. Each test reproduces one specific ordering mistake.
 *
 * WHY the "demonstrates the bug" test is kept rather than deleted: it is executable documentation of
 * the defect. If it starts failing, that means the wiring was fixed and this file's expectations need
 * revisiting -- which is far better than the bug being silently deleted along with its proof.
 */
describe('middleware ordering: CORS must run BEFORE the JSON body parser', () => {
  const servers = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function listen(app) {
    const server = app.listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${server.address().port}`;
  }

  const ALLOWED = 'http://localhost:5173';

  /** CORS-first wiring: the correct order. */
  function correctOrder() {
    const app = express();
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && origin !== ALLOWED) {
        return res.status(403).json({
          error: { code: 'validation', message_safe: 'Origin not allowed.', retryable: false },
        });
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.status(204).end();
      return next();
    });
    app.use(express.json({ limit: 1024 }));
    app.post('/v1/chat/stream', (_req, res) => res.json({ ok: true }));
    return app;
  }

  /** Parser-first wiring: the current createApp()/mountRoutes() shape, reproduced deliberately. */
  function parserFirst() {
    const app = express();
    app.use(express.json({ limit: 1024 }));
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && origin !== ALLOWED) {
        return res.status(403).json({
          error: { code: 'validation', message_safe: 'Origin not allowed.', retryable: false },
        });
      }
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      return next();
    });
    app.post('/v1/chat/stream', (_req, res) => res.json({ ok: true }));
    return app;
  }

  const post = (base, body, origin) => fetch(`${base}/v1/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body,
  });

  it('DOCUMENTS THE DEFECT: malformed JSON from a disallowed origin bypasses the 403', async () => {
    const base = await listen(parserFirst());
    const res = await post(base, '{not valid json', 'https://evil.example');
    // The body parser rejects first, so the caller gets a parser error instead of "origin not
    // allowed" -- which is both an information leak and a missing access-control decision.
    expect(res.status).not.toBe(403);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('FIXED ORDER: disallowed origin with malformed JSON returns 403', async () => {
    const base = await listen(correctOrder());
    const res = await post(base, '{not valid json', 'https://evil.example');
    expect(res.status).toBe(403);
    expect((await res.json()).error.message_safe).toBe('Origin not allowed.');
  });

  it('FIXED ORDER: a disallowed origin is refused even with a large valid body', async () => {
    // WHY size matters: a 100KB body from a blocked origin is a cheap way to make the server spend
    // memory parsing input it was always going to reject.
    const base = await listen(correctOrder());
    const res = await post(base, JSON.stringify({ pad: 'x'.repeat(100_000) }), 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('FIXED ORDER: an allowed origin with malformed JSON still gets a parser error', async () => {
    // WHY: reordering must not swallow genuine validation errors for legitimate callers.
    const base = await listen(correctOrder());
    const res = await post(base, '{not valid json', ALLOWED);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(403);
  });

  it('FIXED ORDER: an allowed origin with a valid body is accepted', async () => {
    const base = await listen(correctOrder());
    const res = await post(base, JSON.stringify({ bot: 'bot1', message: 'hi' }), ALLOWED);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('FIXED ORDER: a preflight from an allowed origin is answered without a body', async () => {
    const base = await listen(correctOrder());
    const res = await fetch(`${base}/v1/chat/stream`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });

  it('FIXED ORDER: a preflight from a disallowed origin is refused', async () => {
    const base = await listen(correctOrder());
    const res = await fetch(`${base}/v1/chat/stream`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('FIXED ORDER: a request with no Origin header is not blocked by CORS', async () => {
    // WHY: same-origin and server-to-server requests carry no Origin. Blocking them would break the
    // health check and any CLI use of the API.
    const base = await listen(correctOrder());
    const res = await post(base, JSON.stringify({ bot: 'bot1', message: 'hi' }), null);
    expect(res.status).toBe(200);
  });
});