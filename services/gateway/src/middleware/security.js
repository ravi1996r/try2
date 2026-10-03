/**
 * Security headers, CORS, rate limiting and the request-id middleware.
 *
 * WHY these live together: they are the "edge" concerns that must apply to EVERY route, and a
 * route added later must not be able to forget them. Putting them in the app-level chain (rather
 * than per-route) is what guarantees that.
 */

/**
 * CSP.
 *
 * WHY script-src is 'self' with no 'unsafe-inline' and no third-party: model output is untrusted and
 * this project stores visitor API keys in the browser. An inline script or a CDN script is a
 * single point of failure for both. Styles are self-hosted too, so style-src stays strict; the only
 * concession is 'unsafe-inline' for style because theme tokens are applied as inline custom
 * properties on a live element, which is data, not code.
 *
 * WHY connect-src lists provider origins: the model switcher calls the visitor's chosen provider
 * DIRECTLY from the browser (ADR-0006). That is a deliberate trust decision, and it is why this
 * header is not simply 'self'. Loopback is included so a visitor's local Ollama/LM Studio works.
 *
 * @param {{allowAnyHttpsEndpoint: boolean, scriptSrc: string, styleSrc: string}} opts
 */
export function buildCsp({ allowAnyHttpsEndpoint, scriptSrc = "'self'", styleSrc = "'self'" }) {
  const connect = allowAnyHttpsEndpoint
    // WHY the trade-off is documented rather than silent: this allows the browser to send the
    // visitor's question and key to ANY https host. It is off by default.
    ? "'self' https: http://localhost:* http://127.0.0.1:*"
    : [
      "'self'",
      // The site gateway.
      'http://localhost:8082',
      'http://127.0.0.1:8082',
      // A visitor's local OpenAI-compatible server.
      'http://localhost:11434', 'http://127.0.0.1:11434', // Ollama
      'http://localhost:1234', 'http://127.0.0.1:1234', // LM Studio
      'http://localhost:8081', 'http://127.0.0.1:8081', // llama.cpp server (NOT 8080: that is ours)
      // Known browser-callable providers for the model switcher.
      'https://api.anthropic.com',
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
      'https://openrouter.ai',
    ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // 'unsafe-inline' is permitted for STYLE ONLY, because theme tokens are applied as inline
    // custom properties. This does not permit inline SCRIPT.
    `style-src ${styleSrc} 'unsafe-inline'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // frame-ancestors 'none' blocks clickjacking of the site.
    "frame-ancestors 'none'",
  ].join('; ');
}

/** @returns {Record<string,string>} the full header set, including HSTS for production. */
export function securityHeaders(config) {
  const headers = {
    'Content-Security-Policy': buildCsp({
      allowAnyHttpsEndpoint: config.allowAnyHttpsEndpoint,
      scriptSrc: config.cspScriptSrc,
      styleSrc: config.cspStyleSrc,
    }),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (config.appEnv === 'production') {
    // WHY only in production: HSTS on http://localhost would make a developer's browser refuse to
    // load the local site for a year. That is a genuinely bad local experience, not a nitpick.
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}
/**
 * Client identity.
 *
 * WHY this is careful about X-Forwarded-For: that header is attacker-controlled unless a trusted
 * proxy overwrites it. Counting distinct values inside it would let one visitor reset their rate
 * limit by appending a random entry per request, and rotating session cookies would do the same.
 * So: only the FIRST hop's IP is used when a proxy is declared, and the session id is INDEPENDENTLY
 * rate limited so that rotating it does not reset the per-IP budget.
 *
 * ALTERNATIVES: trust the full XFF chain (rejected: spoofable), or ignore it entirely (rejected:
 * every request would appear to come from the proxy, making the limit global and useless).
 */
export function clientIp(req, { trustProxy }) {
  if (!trustProxy) return req.socket?.remoteAddress ?? 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Rate limiter.
 *
 * WHY two independent counters: per-IP stops one visitor from many addresses; per-session stops one
 * visitor from rotating session ids. EITHER alone is defeatable, so both must trip.
 *
 * WHY atomic increments and never read-modify-write: see KeyValueStore.increment.
 *
 * @param {object} deps { store, config }
 */
export function createRateLimiter({ store, config }) {
  const trustProxy = Boolean(config.trustProxy);

  /**
   * @param {object} req
   * @param {string} sessionId
   * @returns {Promise<{allowed: boolean, retryAfterSeconds: number, scope?: 'ip'|'session'}>}
   */
  return async function check(req, sessionId) {
    const ip = clientIp(req, { trustProxy });
    const ipKey = `rl:ip:${ip}`;
    const sessionKey = `rl:session:${sessionId}`;

    const ipCount = await store.increment(ipKey, 60);
    if (ipCount > config.rateLimitPerIpPerMinute) {
      return { allowed: false, retryAfterSeconds: 60, scope: 'ip' };
    }
    const sessionCount = await store.increment(sessionKey, 60);
    if (sessionCount > config.rateLimitPerSessionPerMinute) {
      return { allowed: false, retryAfterSeconds: 60, scope: 'session' };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

/**
 * Daily token budget with a circuit breaker.
 *
 * WHY a breaker rather than a per-request check: once the budget is gone, every further request
 * would still cost a lookup and might still slip through a race. The breaker latches, so once
 * tripped NO further provider calls are made -- which is exactly what E2E-22 asserts by counting
 * requests at the fake provider.
 */
export function createBudgetBreaker({ store, config }) {
  const budgetKey = 'budget:tokens:used';
  const breakerKey = 'budget:breaker';
  const dayKey = () => new Date().toISOString().slice(0, 10);

  return {
    async isTripped() {
      return (await store.get(breakerKey)) !== null;
    },

    async remaining() {
      const used = (await store.get(budgetKey))?.value ?? 0;
      return Math.max(0, config.dailyTokenBudget - used);
    },

    /** Records usage and trips the breaker when the budget is exhausted. */
    async record(tokens) {
      if (config.dailyTokenBudget <= 0) {
        await store.set(breakerKey, { day: dayKey(), reason: 'budget_zero' }, { ttlSeconds: 86400 });
        return { tripped: true, used: tokens };
      }
      const used = await store.increment(budgetKey, 86400, tokens);
      if (used >= config.dailyTokenBudget) {
        await store.set(breakerKey, { day: dayKey(), used }, { ttlSeconds: 86400 });
        return { tripped: true, used };
      }
      return { tripped: false, used };
    },

    /** Test/ops helper: clears the breaker and the counter. */
    async reset() {
      await store.delete(budgetKey);
      await store.delete(breakerKey);
    },
  };
}

/**
 * CORS.
 *
 * WHY an exact allow-list and never '*': the gateway holds sessions and can stream on the visitor's
 * behalf. A wildcard would let any site a visitor visits read their responses.
 *
 * @param {object} config
 * @param {string} origin
 * @returns {boolean}
 */
export function isOriginAllowed(config, origin) {
  if (!origin) return true; // same-origin / non-browser client
  const allowed = new Set([config.siteOrigin]);
  // Local dev convenience: Vite may pick a neighbouring port when 5173 is taken.
  if (config.appEnv === 'local') {
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }
  return allowed.has(origin);
}