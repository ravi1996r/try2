import { describe, expect, it } from 'vitest';
import { buildCsp, securityHeaders, isOriginAllowed, clientIp } from '../src/middleware/security.js';
import { loadConfig } from '../src/config.js';

/**
 * WHY these tests exist: the CSP and header set were written but had NO dedicated tests, so a typo
 * that weakened the policy -- a missing `object-src`, an `unsafe-inline` on script-src, a wildcard
 * on connect-src -- would have passed every other suite in the repo.
 *
 * WHY parse the CSP rather than string-match it: substring assertions pass for the wrong reason.
 * `csp.includes("script-src 'self'")` is ALSO true when the value is
 * `script-src 'self' 'unsafe-inline'`, which is the exact thing that must never ship.
 */
function parseCsp(header) {
  const out = {};
  for (const part of header.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) out[tokens[0].toLowerCase()] = tokens.slice(1);
  }
  return out;
}

const baseConfig = {
  allowAnyHttpsEndpoint: false,
  cspScriptSrc: "'self'",
  cspStyleSrc: "'self'",
  appEnv: 'local',
};

describe('Content-Security-Policy', () => {
  it('never permits inline or eval script', () => {
    // WHY the most important assertion: script-src with 'unsafe-inline' or 'unsafe-eval' would let
    // any injected HTML execute, defeating the entire policy.
    const d = parseCsp(buildCsp(baseConfig));
    expect(d['script-src']).toEqual(["'self'"]);
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['script-src']).not.toContain("'unsafe-eval'");
  });

  it('permits inline STYLE only, because themes use CSS custom properties', () => {
    // WHY style-src is the documented exception: the Master bot sets theme tokens as inline custom
    // properties. Removing this breaks theming; the same exception on script-src would be a critical
    // vulnerability. The asymmetry is deliberate and this test pins both halves.
    expect(parseCsp(buildCsp(baseConfig))['style-src']).toContain("'unsafe-inline'");
  });

  it('blocks plugins, framing and form hijacking', () => {
    const d = parseCsp(buildCsp(baseConfig));
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['default-src']).toEqual(["'self'"]);
  });

  it('never contains a bare wildcard in connect-src by default', () => {
    // WHY: connect-src * would let a malicious page exfiltrate the visitor's question, their
    // conversation, and any key held in the browser.
    expect(parseCsp(buildCsp(baseConfig))['connect-src']).not.toContain('*');
  });

  it('allow_any_https_endpoint widens connect-src to https, not to everything', () => {
    const d = parseCsp(buildCsp({ ...baseConfig, allowAnyHttpsEndpoint: true }));
    expect(d['connect-src']).toContain('https:');
    expect(d['connect-src']).not.toContain('*');
  });

  it('does not widen script-src when any-endpoint is allowed', () => {
    // WHY this matters: two independent switches. Conflating them would mean enabling a convenience
    // feature for the model switcher also opened up script execution.
    expect(parseCsp(buildCsp({ ...baseConfig, allowAnyHttpsEndpoint: true }))['script-src'])
      .toEqual(["'self'"]);
  });

  it('includes the local model endpoints the switcher needs', () => {
describe('security headers', () => {
  it('sets every hardening header', () => {
    const h = securityHeaders(baseConfig);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Content-Security-Policy']).toBeTruthy();
  });

  it('sends HSTS in production only', () => {
    // WHY: HSTS on http://localhost would make the browser refuse the local site for a year.
    expect(securityHeaders({ ...baseConfig, appEnv: 'production' })['Strict-Transport-Security'])
      .toContain('max-age=31536000');
    expect(securityHeaders({ ...baseConfig, appEnv: 'local' })['Strict-Transport-Security'])
      .toBeUndefined();
  });

  it('disables camera, microphone and geolocation', () => {
    const p = securityHeaders(baseConfig)['Permissions-Policy'];
    expect(p).toContain('microphone=()');
    expect(p).toContain('geolocation=()');
  });
});

describe('origin allowlist', () => {
  const local = { appEnv: 'local', siteOrigin: 'https://portfolio.example' };
  const prod = { appEnv: 'production', siteOrigin: 'https://portfolio.example' };

  it('allows the configured origin', () => {
    expect(isOriginAllowed(local, 'https://portfolio.example')).toBe(true);
  });

  it('allows a request with no Origin header', () => {
    // WHY: same-origin requests and server-to-server calls carry no Origin. Blocking them would
    // break the health check and every CLI consumer.
    expect(isOriginAllowed(local, undefined)).toBe(true);
    expect(isOriginAllowed(local, '')).toBe(true);
  });

  it('refuses an unrelated origin', () => {
    expect(isOriginAllowed(local, 'https://evil.example')).toBe(false);
  });

  it('is exact-match, not prefix or suffix match', () => {
    // WHY this is the classic bypass: `notportfolio.example` and `portfolio.example.evil.com` both
    // touch the real host as a substring. An exact Set lookup is immune to both.
    expect(isOriginAllowed(local, 'https://portfolio.example.evil.com')).toBe(false);
    expect(isOriginAllowed(local, 'https://notportfolio.example')).toBe(false);
    expect(isOriginAllowed(local, 'https://portfolio.example:8443')).toBe(false);
  });

  it('does not treat http and https as interchangeable', () => {
    // WHY: an http origin is a different trust domain. Someone who can serve http cannot be assumed
    // to control https, and vice versa.
    expect(isOriginAllowed(local, 'http://portfolio.example')).toBe(false);
  });

  it('allows the Vite dev port in local mode only', () => {
    // WHY: Vite may pick a neighbour port when 5173 is taken, so local dev needs it. In production
    // that leniency must not exist.
    expect(isOriginAllowed(local, 'http://localhost:5173')).toBe(true);
    expect(isOriginAllowed(prod, 'http://localhost:5173')).toBe(false);
  });
});

describe('client IP resolution', () => {
  const req = (headers, socketAddress = '203.0.113.7') => ({
    headers,
    socket: { remoteAddress: socketAddress },
  });

  it('uses the socket address when no proxy is trusted', () => {
    expect(clientIp(req({}), { trustProxy: false })).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For entirely when no proxy is trusted', () => {
    // WHY this is the important case: an untrusted XFF is attacker-controlled. Honouring it would
    // let anyone reset their rate limit with a random header.
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false })).toBe('203.0.113.7');
  });

  it('uses only the FIRST forwarded hop when a proxy is trusted', () => {
    // WHY first and not last: appending is trivial for a client, so only the entry a real proxy
    // wrote can be trusted.
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }, '10.0.0.1'),
      { trustProxy: 1 })).toBe('198.51.100.9');
  });

  it('falls back to the socket when the header is absent or empty', () => {
    expect(clientIp(req({ 'x-forwarded-for': '' }, '10.0.0.1'), { trustProxy: 1 })).toBe('10.0.0.1');
  });
});

describe('headers are driven by real config', () => {
  it('buildCsp honours the configured script source', () => {
    // WHY: the header comes from config, so a config regression must surface here rather than only
    // in a hand-built object.
    const cfg = loadConfig({
      APP_ENV: 'local',
      PORTFOLIO_CSP_SCRIPT_SRC: "'self' https://cdn.example",
    });
    expect(parseCsp(securityHeaders(cfg)['Content-Security-Policy'])['script-src'])
      .toContain('https://cdn.example');
  });
});
    const connect = parseCsp(buildCsp(baseConfig))['connect-src'];
    for (const o of ['http://127.0.0.1:11434', 'http://127.0.0.1:1234', 'http://127.0.0.1:8082']) {
      expect(connect).toContain(o);
    }
  });

  it('does not include port 8080 in connect-src by default', () => {
    // WHY: 8080 is the AI service, which the BROWSER must never call directly -- only the gateway
    // talks to it. Allowing it from the page would bypass every control the gateway enforces.
    expect(parseCsp(buildCsp(baseConfig))['connect-src']).not.toContain('http://127.0.0.1:8080');
  });
});