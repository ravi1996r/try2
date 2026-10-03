/**
 * Express application: the gateway's HTTP surface.
 *
 * WHY the gateway owns this and not the AI service: rate limiting, CORS, security headers, session
 * identity and SSE fan-out are per-VISITOR concerns, and the AI service is explicitly internal. The
 * browser only ever talks to this process.
 *
 * ROUTES
 *   GET  /healthz          liveness + label-only backend summary (no secrets)
 *   GET  /v1/config        public config for the UI (labels only)
 *   POST /v1/chat/stream   the site path: SSE, tokens streamed from the provider
 *   POST /v1/prepare       the browser path: context assembly only, no model call
 *
 * SECURITY NOTES
 *   - Visitor API keys are REJECTED here. Any key-like field or provider auth header on a request to
 *     this API is refused without echoing the value: the server never needs one and must never hold one.
 *   - Security headers and CORS are applied app-level, so a route added later cannot forget them.
 */

import express from 'express';

import { loadConfig } from './config.js';
import {
  createMemoryKeyValueStore, createDiskKeyValueStore,
} from './backends/keyvalue.js';
import { createModelGateway, ModelGatewayError, MODEL_EVENT } from './backends/model-gateway.js';
import {
  securityHeaders, isOriginAllowed, createRateLimiter, createBudgetBreaker,
} from './middleware/security.js';
import {
  newRequestId, statusEvent, tokenEvent, sourceEvent, errorEvent, doneEvent,
} from './events.js';

/** Fields that must never be accepted on a request to OUR API (the brief's BYOK rules). */
export const FORBIDDEN_FIELDS = [
  'api_key', 'apiKey', 'authorization', 'x-api-key', 'anthropic_api_key',
  'openai_api_key', 'gemini_api_key', 'access_token', 'bearer', 'visitor_api_key',
];

/**
 * Rejects a request that carries a key-like field or header.
 *
 * WHY reject rather than ignore: silently accepting and discarding a visitor's key would leave them
 * believing BYOK works through our server when it does not, and would put a live credential into our
 * request logs. Refusing is honest and keeps the secret out of memory.
 *
 * @returns {string|null} a safe reason code, or null when the request is acceptable
 */
export function findForbiddenCredential(body, headers = {}) {
  const lowerHeaders = Object.keys(headers).map((h) => h.toLowerCase());
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body ?? {}, field)) return `field:${field}`;
  }
  // WHY these headers specifically: they are the auth headers every supported provider uses, so their
  // presence means the browser is sending a credential to us instead of directly to the provider.
  for (const h of ['authorization', 'x-api-key', 'anthropic-api-key']) {
    if (lowerHeaders.includes(h)) return `header:${h}`;
  }
  return null;
}

/**
 * Builds the app and its dependencies.
 *
 * WHY it returns deps alongside the app: a module-level singleton cannot be reconfigured per test
 * without leaking state between suites. Tests need a synthetic config and a handle on the store.
 */
export function createApp({ env = process.env, store: injectedStore } = {}) {
  const config = loadConfig(env);

  const storePromise = injectedStore
    ? Promise.resolve(injectedStore)
    : (config.cacheBackend === 'disk'
      // WHY disk only when configured: it writes to data/, which must never be served.
      ? createDiskKeyValueStore({ dir: `${config.dataDir}/cache` })
      // WHY memory is the default: no service and no filesystem means the zero-credential boot works.
      : Promise.resolve(createMemoryKeyValueStore()));

  // WHY the thin adapter: the limiter and breaker are written against the async KeyValueStore
  // interface, so they work unchanged with memory, disk or Redis behind the promise.
  const asyncStore = {
    get: (k) => storePromise.then((s) => s.get(k)),
    set: (k, v, o) => storePromise.then((s) => s.set(k, v, o)),
    delete: (k) => storePromise.then((s) => s.delete(k)),
    deleteByPrefix: (p) => storePromise.then((s) => s.deleteByPrefix(p)),
    increment: (k, t, a) => storePromise.then((s) => s.increment(k, t, a)),
    setIfAbsent: (k, v, t) => storePromise.then((s) => s.setIfAbsent(k, v, t)),
    size: () => storePromise.then((s) => s.size()),
    clear: () => storePromise.then((s) => s.clear()),
  };

  const gateway = createModelGateway(config);
  const rateLimiter = createRateLimiter({ store: asyncStore, config });
  const budget = createBudgetBreaker({ store: asyncStore, config });

  const app = express();
  app.disable('x-powered-by');
  // WHY trust proxy is OFF: the gateway binds loopback in dev and sits behind exactly one known proxy
  // in production. Trusting X-Forwarded-For by default would let any visitor spoof their IP and reset
  // their rate limit, which is the cheapest possible bypass.
  app.set('trust proxy', false);

  app.use(express.json({ limit: config.requestMaxBytes }));

  return { app, config, gateway, rateLimiter, budget, store: asyncStore, _rawStore: storePromise };
}
/**
 * Validates a chat request body.
 * @returns {{ok: true, value: object} | {ok: false, message: string}}
 */
export function validateChatBody(body, { historyMaxMessages = 12 } = {}) {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'Expected a JSON body.' };
  }
  // WHY reject rather than strip: silently discarding a visitor's key would leave them believing BYOK
  // works through our server when it does not, and would put a live credential into request logs.
  const forbidden = findForbiddenCredential(body, {});
  if (forbidden) {
    return {
      ok: false,
      message: 'Do not send API keys to this server. Enter your key in the model settings panel; it '
        + 'stays in your browser and goes directly to your provider.',
    };
  }
  if (!['bot1', 'bot2', 'bot3'].includes(body.bot)) {
    return { ok: false, message: 'bot must be bot1, bot2 or bot3.' };
  }
  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return { ok: false, message: 'message is required.' };
  }
  if (body.message.length > 8000) {
    return { ok: false, message: 'message is too long (max 8000 characters).' };
  }
  if (body.history !== undefined && !Array.isArray(body.history)) {
    return { ok: false, message: 'history must be an array.' };
  }
  // WHY a generous multiple: history is capped server-side too. This bound only stops an enormous
  // payload reaching the AI service.
  if (Array.isArray(body.history) && body.history.length > historyMaxMessages * 3) {
    return { ok: false, message: 'too many history messages.' };
  }
  for (const h of body.history ?? []) {
    // WHY the role allow-list: a client-supplied "system" turn would be an injection route into the
    // model's policy. The AI service drops it too; rejecting here is earlier and clearer.
    if (h && h.role && !['user', 'assistant'].includes(h.role)) {
      return { ok: false, message: 'history entries must have role user or assistant.' };
    }
  }
  return { ok: true, value: body };
}

/** The typed error envelope every non-SSE failure uses. */
export function errorBody(code, messageSafe, requestId, extra = {}) {
  return {
    error: {
      code,
      // WHY cap the length: this string reaches the UI and may reach a log. It must never be able to
      // carry a stack trace, a prompt, or a secret.
      message_safe: String(messageSafe ?? '').slice(0, 600),
      retryable: Boolean(extra.retryable),
      ...(extra.next_step ? { next_step: String(extra.next_step).slice(0, 400) } : {}),
      request_id: requestId,
    },
  };
}

/**
 * Applies the global edge middleware and mounts every route.
 *
 * WHY a separate function rather than inline in createApp: the middleware ORDER that tests exercise
 * must be visible in one place, so a new route cannot be added above the security headers by accident.
 *
 * ORDER IS DELIBERATE:
 *   1. security headers -- applied to EVERY response including errors, so a 500 still carries CSP
 *   2. CORS             -- before body parsing, so a rejected origin costs nothing
 *   3. request id       -- so every downstream log line can be correlated
 */
export function mountRoutes(ctx) {
  const { app, config, gateway, budget } = ctx;

  app.use((req, res, next) => {
    for (const [k, v] of Object.entries(securityHeaders(config))) res.setHeader(k, v);
    const origin = req.headers.origin;
    if (origin) {
      if (!isOriginAllowed(config, origin)) {
        // WHY a bare refusal with no CORS header: the browser must not be able to read the reason.
        return res.status(403).json({
          error: { code: 'validation', message_safe: 'Origin not allowed.', retryable: false },
        });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      // WHY Vary: Origin -- a shared cache must not serve one origin's CORS headers to another.
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', req.headers['x-request-id'] || newRequestId());
    next();
  });

  app.get('/healthz', async (_req, res) => {
    res.json({
      ok: true,
      service: 'gateway',
      app_env: config.appEnv,
      // WHY labels only: an operator needs to know WHICH backends are live; nobody needs the values.
      backends: {
        db: config.dbBackend, cache: config.cacheBackend, vector: config.vectorBackend,
        blob: config.blobBackend, llm: config.llmProvider,
        embeddings: config.embeddingProvider, search: config.searchProvider,
      },
      // WHY exposed: the UI must be able to tell a visitor the site model is unavailable and WHY.
      site_model: {
        available: Boolean(gateway.adapter),
        provider_label: gateway.providerLabel,
        cost_label: gateway.costLabel,
        reason: gateway.reason ?? null,
      },
      budget: { remaining: await budget.remaining(), tripped: await budget.isTripped() },
    });
  });

  app.get('/v1/config', (_req, res) => {
    // WHY this endpoint exists and is public: the browser needs provider labels and theme metadata
    // before it can render. Labels and flags ONLY -- never a key, a credentialed URL, or an internal
    // address.
    res.json({
      site_origin: config.siteOrigin,
      themes: ['chill', 'cyberpunk', 'fantasy', 'retro', 'modern'],
      bots: ['bot1', 'bot2', 'bot3'],
      site_model: {
        available: Boolean(gateway.adapter),
        provider_label: gateway.providerLabel,
        cost_label: gateway.costLabel,
        reason: gateway.reason ?? null,
      },
      search: {
        provider: config.searchProvider,
        // WHY the experimental label travels in the API: the UI must show it wherever the mode is
        // displayed, and hardcoding it in one component and forgetting another is exactly the drift
        // this prevents.
        experimental: config.searchProvider === 'ddg',
        disabled_reason: config.searchProvider === 'none'
          ? 'Web search is disabled on this deployment.'
          : null,
      },
      allow_any_https_endpoint: config.allowAnyHttpsEndpoint,
      trust_proxy: false,
      limits: {
        max_message_chars: 8000,
        history_max_messages: config.historyMaxMessages,
      },
    });
  });

  return ctx;
}

/**
 * Mounts POST /v1/chat/stream (the site path).
 *
 * WHY SSE and not WebSocket: the traffic is one POST followed by server-to-client token frames. SSE
 * does exactly that over plain HTTP, reconnects automatically and passes through every proxy. A
 * WebSocket would add a handshake and a state machine to save nothing.
 *
 * CANCELLATION: an aborted request aborts an AbortController which the Model Gateway bridges to the
 * PROVIDER connection. E2E-12 asserts the upstream call was really aborted -- not merely that the UI
 * stopped rendering.
 */
export function mountChatRoutes(ctx, { prepareTurn } = {}) {
  const { app, config, gateway, rateLimiter, budget } = ctx;

  app.post('/v1/chat/stream', async (req, res) => {
    const requestId = String(req.headers['x-request-id'] || newRequestId());

    // --- credentials must never arrive here -------------------------------------------------
    const headerForbidden = findForbiddenCredential({}, req.headers);
    if (headerForbidden) {
      return res.status(400).json(errorBody('validation',
        'Do not send provider credentials to this server. Your key belongs in the model settings '
        + 'panel in your browser.',
        requestId, { next_step: 'Open the model settings and enter your key there.' }));
    }

    const check = validateChatBody(req.body, { historyMaxMessages: config.historyMaxMessages });
    if (!check.ok) return res.status(400).json(errorBody('validation', check.message, requestId));

    const body = check.value;
    const sessionId = String(body.session_id || req.ip || 'anon').slice(0, 128);

    // --- rate limit, BEFORE any provider call ----------------------------------------------
    const limit = await rateLimiter(req, sessionId);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return res.status(429).json(errorBody('rate_limited',
        'Too many requests. Please wait a moment before sending another message.', requestId,
        { retryable: true, next_step: `Wait about ${limit.retryAfterSeconds} seconds, then try again.` }));
    }

    // --- budget breaker, BEFORE any provider call ------------------------------------------
    if (await budget.isTripped()) {
      return res.status(503).json(errorBody('budget_exhausted',
        "The site's daily assistant budget is used up, so chat is paused until it resets.", requestId,
        { next_step: 'Try again tomorrow, or use your own model from the model settings.' }));
    }

    // --- unconfigured site model: REPORT it, never silently switch --------------------------
    if (!gateway.adapter) {
      return res.status(503).json(errorBody('not_configured', gateway.reason, requestId,
        { next_step: 'Open the model settings to use your own model.' }));
    }

    // --- prepare: retrieval + prompt assembly ----------------------------------------------
    let prepared = null;
    if (typeof prepareTurn === 'function') {
      try {
        prepared = await prepareTurn({
          bot: body.bot, message: body.message, history: body.history ?? [], requestId,
        });
      } catch {
        // WHY retrieval failure degrades instead of failing the request: a broken index should leave
        // the visitor with the static site and an honest message, not a dead chat panel.
        return res.status(503).json(errorBody('retrieval_failure',
          'Source search is unavailable right now, so answers may be incomplete.', requestId,
          { retryable: true, next_step: 'Try again in a moment.' }));
      }
    }

    // --- SSE handshake ----------------------------------------------------------------------
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // WHY X-Accel-Buffering: no -- nginx buffers SSE by default, which would hold every token until
      // the response ended and destroy streaming entirely.
      'X-Accel-Buffering': 'no',
    });
    // WHY the priming comment: some proxies, and EventSource itself, wait for the first byte before
    // firing onopen. Without it the stream can look like it hung for seconds.
    res.write(':ok\n\n');

    const send = (event) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const startedAt = Date.now();
    let ttftMs = 0;
    let usage = { prompt: 0, completion: 0 };
    let text = '';

    send({
      type: 'meta',
      request_id: requestId,
      meta: {
        bot: body.bot,
        path: 'site',
        provider_label: gateway.adapter.providerLabel ?? gateway.providerLabel,
        model_label: gateway.adapter.modelLabel ?? 'unknown',
        key_source: 'site',
        cost_label: gateway.adapter.costLabel ?? gateway.costLabel,
      },
    });
    send(statusEvent(requestId, 'queued'));

    const controller = new AbortController();
    const onClose = () => controller.abort(new Error('client_disconnected'));
    req.on('close', onClose);
    res.on('close', onClose);

    try {
      send(statusEvent(requestId, 'processing'));

      if (prepared?.sources?.length) {
        send(statusEvent(requestId, 'retrieving', `Found ${prepared.sources.length} sources.`));
        for (const s of prepared.sources) {
          send(sourceEvent(requestId, {
            id: s.id, kind: s.kind, title: s.title, locator: s.locator, score: s.score,
          }));
        }
      }

      send(statusEvent(requestId, 'streaming'));

      // WHY tokens are BUFFERED rather than forwarded immediately: the canary check can only run
      // once the stream is complete. Forwarding tokens as they arrive meant a model that echoed its
      // system prompt had already leaked it to the visitor before the check fired -- the check
      // detected the leak but could not undo it. Buffering trades a small amount of first-token
      // latency for the guarantee that a leaked prompt is never rendered.
      //
      // The buffer is bounded: a model that ignores max_tokens cannot make this grow without limit.
      let buffered = '';
      const MAX_BUFFERED = 20000;
      let overflowed = false;

      for await (const evt of gateway.adapter.stream({
        messages: prepared?.messages ?? [{ role: 'user', content: body.message }],
        maxTokens: prepared?.limits?.max_output_tokens ?? config.llmMaxOutputTokens,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        if (evt.type === MODEL_EVENT.TOKEN) {
          if (ttftMs === 0) ttftMs = Date.now() - startedAt;
          buffered += evt.text;
          if (buffered.length > MAX_BUFFERED) {
            // WHY stop accumulating rather than truncate silently: an over-long response is itself a
            // signal, and continuing would hide it.
            overflowed = true;
            break;
          }
        } else if (evt.type === MODEL_EVENT.USAGE) {
          usage = evt.usage ?? usage;
        }
      }

      // --- canary check, BEFORE anything is sent to the visitor ------------------------------
      // WHY this must precede the first token frame: the AI service plants a random token in the
      // system prompt. If it appears in the output, the model echoed its instructions -- a prompt
      // leak that is invisible unless asserted.
      const canary = prepared?._canary;
      if (overflowed) {
        send(errorEvent(requestId, 'internal',
          'The response was too long and was discarded.',
          { nextStep: 'Please ask a more specific question.', retryable: false }));
        return res.end();
      }
      if (canary && buffered.includes(canary)) {
        // WHY discard rather than redact: a partial redaction can still leak fragments, and a
        // response that leaked its prompt is not trustworthy at all.
        send(errorEvent(requestId, 'internal',
          'The response was discarded because it failed a safety check.',
          { nextStep: 'Please ask again.', retryable: true }));
        return res.end();
      }

      // --- safe to render --------------------------------------------------------------------
      text = buffered;
      send(tokenEvent(requestId, buffered));

      await budget.record(Math.max(1, usage.prompt + usage.completion));
      send(statusEvent(requestId, 'completed'));
      send(doneEvent(requestId, {
        prompt: usage.prompt, completion: usage.completion, ttftMs, totalMs: Date.now() - startedAt,
      }));
      return undefined;
    } catch (err) {
      if (controller.signal.aborted) {
        send(statusEvent(requestId, 'cancelled'));
      } else if (err instanceof ModelGatewayError) {
        send(statusEvent(requestId, 'failed', err.safeMessage));
        send(errorEvent(requestId, err.code, err.safeMessage, { nextStep: err.nextStep }));
      } else {
        // WHY a generic message: an unexpected exception may carry a stack trace, a file path or part
        // of a prompt. None of those may reach a visitor or a log line.
        send(statusEvent(requestId, 'failed'));
        send(errorEvent(requestId, 'internal', 'Something went wrong while answering.',
          { nextStep: 'Please try again.', retryable: true }));
      }
      return undefined;
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  });

  return ctx;
}
