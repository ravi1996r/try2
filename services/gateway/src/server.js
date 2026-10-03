/**
 * Gateway process entry point.
 *
 * WHY a separate file rather than running app.js directly: app.js exports a factory and has no side
 * effects, which is what makes it testable. This file is the only place that binds a port.
 */

import { createApp, mountRoutes, mountChatRoutes } from './app.js';
import { loadConfig, startupBanner } from './config.js';
import { createHmac, createHash } from 'node:crypto';

/**
 * Calls the Python AI service's /internal/v1/prepare.
 *
 * WHY the failure modes are explicit rather than swallowed: each one produces a DIFFERENT visitor
 * message. "AI service down" and "retrieval failed" are different problems with different fixes, and
 * conflating them sends operators hunting the wrong bug.
 *
 * @returns {Promise<object>} the PreparedTurn
 */
function createAiClient(config) {
  const base = config.aiServiceBaseUrl;
  const secret = config.secrets.PORTFOLIO_INTERNAL_SERVICE_AUTH;

  return async function prepareTurn({ bot, message, history }) {
    if (config.appEnv === 'production' && !secret) {
      throw new Error('PORTFOLIO_INTERNAL_SERVICE_AUTH is required in production');
    }
    // WHY the token is minted per request with a short TTL rather than reused: a reused token widens
    // the blast radius of a leak and has no natural rotation point.
    const token = secret ? mintToken(secret, config.internalServiceAuthTtlSeconds) : '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('ai_timeout')), 15000);
    try {
      const res = await fetch(`${base}/internal/v1/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // WHY the header, not a query parameter: a token in a URL lands in proxy logs.
          ...(token ? { 'X-Portfolio-Token': token } : {}),
        },
        body: JSON.stringify({ bot, message, history }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // WHY a generic message: the AI service's body may contain internal detail.
        throw new Error(`ai_service_status_${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Mirrors the Python `sign_token` exactly.
 *
 * WHY this is duplicated rather than shared: the gateway is Node and the AI service is Python, and a
 * shared implementation would mean either a JS runtime in the Python service or a Python runtime in
 * Node. Both are heavier than six lines of HMAC. The contract tests assert both sides agree, so a
 * divergence fails CI rather than silently rejecting every request in production.
 */
function mintToken(secret, ttlSeconds) {
  const id = createHash('sha256').update(secret).digest('hex').slice(0, 8);
  const payload = `${id}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${sig}`;
}

export async function startServer(env = process.env) {
  const ctx = createApp({ env });
  mountRoutes(ctx);
  mountChatRoutes(ctx, { prepareTurn: createAiClient(ctx.config) });

  const { app, config } = ctx;
  const server = app.listen(config.port, config.host, () => {
    console.log(`[gateway] listening on http://${config.host}:${config.port}`);
    console.log(`[gateway] site origin ${config.siteOrigin}`);
    console.log(`[gateway] ai service ${config.aiServiceBaseUrl}`);
    console.log(`[gateway] site model ${ctx.gateway.providerLabel}`
      + `${ctx.gateway.adapter ? '' : ' (UNAVAILABLE)'}`);
    if (ctx.gateway.reason) console.log(`[gateway] reason: ${ctx.gateway.reason}`);
  });
  return { server, ctx };
}

// Run directly: `node services/gateway/src/server.js`
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('server.js');
if (invokedDirectly) {
  const config = loadConfig();
  console.log(startupBanner(config));
  startServer();
}

export { createHmac, createHash };