/**
 * FAKE PROVIDER SERVER — test-only double for LLM and web-search providers.
 *
 * ####################################################################################################
 * # THIS IS NOT A REAL PROVIDER. Every response it serves is tagged as fake, and it refuses to     #
 * # start when APP_ENV=production. It exists so the ENTIRE streaming path can be exercised with   #
 * # zero credentials and zero cloud access, which is the only way `npm run verify` can be honest.  #
 * ####################################################################################################
 *
 * WHY a real HTTP server instead of a library mock: a mock of `fetch` proves my code calls the
 * function I think it calls. A fake SERVER proves the wire format, the SSE framing, the abort
 * propagation, the retry classification and the error mapping -- the parts that actually break in
 * production. It is the outermost edge of the system and nothing else is mocked.
 *
 * ALTERNATIVES considered:
 *  - nock/msw (rejected: they intercept a client, so they cannot prove real SSE framing or real
 *    socket-level abort behaviour, which is exactly what E2E-12 needs to demonstrate).
 *  - Recorded fixtures (rejected: recordings cannot produce the fault modes - 429, 5xx, mid-stream
 *    drop, slow response - that the degradation matrix requires).
 *  - A stubbed Model Gateway inside the AI service (rejected: that would test nothing about the
 *    adapter that actually talks to a provider).
 *
 * TRADE-OFF: the fake implements the provider's OBSERVABLE behaviour, not its model quality. It
 * can prove plumbing and determinism; it can never prove answer quality. That is what evals:live is
 * for, and conflating the two would be the worst possible outcome for this project's honesty.
 *
 * Env:
 *   PORT                     OpenAI-compatible port (default 8090)
 *   FAKE_PROVIDERS_OLLAMA_PORT     Ollama native port      (default 8091)
 *   FAKE_PROVIDERS_ANTHROPIC_PORT  Anthropic Messages port  (default 8092)
 *   FAKE_PROVIDERS_GEMINI_PORT     Gemini port             (default 8093)
 *   FAKE_PROVIDERS_SEARCH_PORT     web-search port         (default 8094)
 *   FAKE_CORS                 'on' (default) | 'off' — toggled by tests to exercise CORS failure
 */

import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Marker added to every response so a fake can never be mistaken for a real provider.
 *
 * WHY two constants and not one: FAKE_MARKER is the header NAME (a valid HTTP token), while the
 * old single constant held the whole string "X-Portfolio-Fake-Provider: 1". Using that as an object
 * key produced a header literally named "X-Portfolio-Fake-Provider: 1", which Node rejects with
 * ERR_INVALID_HTTP_TOKEN. Every response threw, and because the throw happened inside the HTTP
 * server the tests hung rather than failing fast. Two constants cannot be confused this way.
 */
export const FAKE_MARKER = 'X-Portfolio-Fake-Provider';
export const FAKE_MARKER_VALUE = '1';
export const FAKE_MARKER_BODY = '[FAKE PROVIDER - not a real model]';

/**
 * Recorded requests, so tests can assert call counts, headers and cancellation. This is the
 * mechanism behind E2E-18 ("exactly zero calls to the search adapter") and E2E-12 (the upstream
 * request was actually aborted).
 */
const requestLog = [];

/** @returns {Array<object>} a copy of the recorded requests */
export function getRequestLog() {
  return requestLog.map((r) => ({ ...r }));
}

export function clearRequestLog() {
  requestLog.length = 0;
}

/**
 * CORS is a toggle rather than always-on: several tests need the browser path to FAIL with a
 * cross-origin error so the "CORS blocked" message and next step can be verified (E2E-34).
 */
let corsEnabled = true;
export function setCorsEnabled(on) {
  corsEnabled = Boolean(on);
}
export function getCorsEnabled() {
  return corsEnabled;
}

const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    [FAKE_MARKER]: FAKE_MARKER_VALUE,
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(payload);
};

function corsHeaders() {
  if (!corsEnabled) return {};
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Expose-Headers': FAKE_MARKER,
  };
}
/** Deterministic reply text. WHY deterministic: assertions on streamed content must not be flaky. */
const DEFAULT_REPLY =
  'Ravi works as an AI Backend Engineer at Tata Consultancy Services on an enterprise Generative '
  + 'AI assistant, building RAG pipelines and high-concurrency FastAPI and Node.js services.';

/**
 * Fault injection driven by the incoming message, so a test can trigger a mode purely by sending
 * a command it recognises. Using message content rather than a control endpoint keeps the fault
 * modes inside the ordinary request path, which is what the AI service actually uses.
 *
 * @param {string} message
 * @returns {{mode: string, status?: number}}
 */
export function detectFaultMode(message) {
  const m = (message || '').toLowerCase();
  if (m.includes('__fake_429')) return { mode: 'rate_limited', status: 429 };
  if (m.includes('__fake_500')) return { mode: 'server_error', status: 500 };
  if (m.includes('__fake_401')) return { mode: 'unauthorized', status: 401 };
  if (m.includes('__fake_404')) return { mode: 'not_found', status: 404 };
  if (m.includes('__fake_timeout')) return { mode: 'timeout' };
  if (m.includes('__fake_drop')) return { mode: 'midstream_drop' };
  if (m.includes('__fake_slow')) return { mode: 'slow' };
  return { mode: 'normal' };
}

/**
 * Streams an OpenAI-compatible SSE response.
 *
 * WHY the frames are emitted in small chunks with a delay: a single-frame "stream" would make
 * token-by-token rendering untestable, and E2E-09 requires at least three chunks with the first
 * token arriving before completion. The delay is short so tests stay fast.
 */
async function streamOpenAICompatible(res, reply, fault) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    [FAKE_MARKER]: FAKE_MARKER_VALUE,
    ...corsHeaders(),
  });

  const delayMs = fault.mode === 'slow' ? 1500 : 5;
  const tokens = reply.match(/\S+\s*/g) ?? [reply];

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    // The role-only opening frame is what the real API sends first.
    send({ id: 'fake-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

    for (const [i, piece] of tokens.entries()) {
      // WHY check destroyed on every iteration: a client abort mid-stream must stop generating
      // tokens. This is the server-side half of the cancellation proof in E2E-12.
      if (res.destroyed || res.writableEnded) return;
      send({ id: 'fake-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      if (fault.mode === 'midstream_drop' && i === Math.floor(tokens.length / 2)) {
        // WHY destroy rather than end: a real provider dropping the connection mid-stream is a
        // transport failure, and the client must surface it as an error, not as a short answer.
        res.destroy();
        return;
      }
      await delay(delayMs);
    }

    send({ id: 'fake-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({
      id: 'fake-1',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 42, completion_tokens: tokens.length, total_tokens: 42 + tokens.length },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    // A client abort surfaces here; there is nothing to do and nothing worth logging loudly.
    if (!res.destroyed) res.end();
  }
}

/** Reads a JSON body with a hard size cap. WHY: an unbounded read is a trivial DoS. */
function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

const extractMessage = (body) => {
  if (typeof body?.input === 'string') return body.input; // Gemini
  // WHY the Gemini `contents` shape is handled here: the real API sends
  // { contents: [{ role, parts: [{ text }] }] }. Without this, the message would be empty, the
  // fake would fall back to DEFAULT_REPLY, and a test asserting the echo would fail in a way that
  // looks like a streaming bug rather than an extraction bug.
  if (Array.isArray(body?.contents)) {
    const last = body.contents[body.contents.length - 1];
    if (Array.isArray(last?.parts)) return last.parts.map((p) => p?.text ?? '').join(' ');
    if (typeof last?.text === 'string') return last.text;
  }
  if (Array.isArray(body?.messages)) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last?.content === 'string') return last.content;
    if (Array.isArray(last?.content)) {
      return last.content.map((p) => p?.text ?? '').join(' ');
    }
  }
  if (typeof body?.prompt === 'string') return body.prompt; // Ollama legacy
  return '';
};

/**
 * Ollama native format: newline-delimited JSON objects, NOT SSE. Implementing it separately is the
 * point of having a per-provider adapter — an adapter that only ever saw SSE would pass every test
 * here and fail against a real Ollama.
 */
async function streamOllama(res, reply, fault) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    [FAKE_MARKER]: FAKE_MARKER_VALUE,
    ...corsHeaders(),
  });
  const tokens = reply.match(/\S+\s*/g) ?? [reply];
  for (const piece of tokens) {
    if (res.destroyed) return;
    res.write(`${JSON.stringify({ model: 'fake', response: piece, done: false })}\n`);
    await delay(2);
  }
  res.write(`${JSON.stringify({ model: 'fake', response: '', done: true, done_reason: 'stop' })}\n`);
  res.end();
}

/**
 * Anthropic Messages format. Note the DIFFERENT event names (`content_block_delta`,
 * `message_delta`) and that streaming is SSE with named events rather than bare `data:` frames.
 * An adapter that assumed OpenAI framing would silently produce no text here.
 */
async function streamAnthropic(res, reply, fault) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    [FAKE_MARKER]: FAKE_MARKER_VALUE,
    ...corsHeaders(),
  });
  const send = (event, obj) => res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'fake-msg', role: 'assistant' } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const tokens = reply.match(/\S+\s*/g) ?? [reply];
  for (const piece of tokens) {
    if (res.destroyed) return;
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: piece },
    });
    await delay(2);
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: tokens.length },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/** Gemini streaming uses `streamGenerateContent?alt=sse` with OpenAI-ish data frames. */
async function streamGemini(res, reply) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    [FAKE_MARKER]: FAKE_MARKER_VALUE,
    ...corsHeaders(),
  });
  const tokens = reply.match(/\S+\s*/g) ?? [reply];
  for (const piece of tokens) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: piece }] } }],
    })}\n\n`);
    await delay(2);
  }
  res.end();
}

/**
 * The fake web-search provider. It is a DOUBLE, so its results are obviously synthetic, and it is
 * on a separate port so a test can prove "zero calls to the search adapter" by counting requests
 * here (E2E-18).
 */
function handleSearch(req, res, url) {
  const q = url.searchParams.get('q') ?? '';
  requestLog.push({ kind: 'search', provider: 'fake-search', q, at: Date.now() });

  if (q.includes('__fake_500')) return json(res, 500, { error: 'fake search outage' });
  if (q.includes('__fake_empty')) return json(res, 200, { results: [] });

  json(res, 200, {
    // WHY the marker is inside the payload too: a developer screenshotting a result can see at a
    // glance that the data did not come from a real engine.
    _fake: FAKE_MARKER_BODY,
    query: q,
    results: [
      { title: `Fake result 1 for ${q}`, url: 'https://example.invalid/1', snippet: `${FAKE_MARKER_BODY} synthetic snippet.` },
      { title: `Fake result 2 for ${q}`, url: 'https://example.invalid/2', snippet: `${FAKE_MARKER_BODY} synthetic snippet.` },
    ],
  });
}

/** Model listing, so the "Test & switch" probe has something real to call. */
function handleModels(res, format) {
  const models = { object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'fake' }] };
  if (format === 'ollama') return json(res, 200, { models: [{ name: 'fake-model', model: 'fake-model' }] });
  if (format === 'anthropic') {
    return json(res, 200, { data: [{ id: 'claude-fake', type: 'model' }], has_more: false });
  }
  if (format === 'gemini') {
    return json(res, 200, { models: [{ name: 'models/fake-gemini', displayName: 'Fake Gemini' }] });
  }
  return json(res, 200, models);
}

/**
 * Builds one fake server bound to a port and a wire format.
 *
 * @param {{port: number, format: 'openai'|'ollama'|'anthropic'|'gemini'|'search'}} opts
 */
export function createFakeServer({ port, format }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(corsEnabled ? 204 : 403, corsHeaders());
      return res.end();
    }

    // A tiny control surface for tests. Read-only and test-only; it exposes no model behaviour.
    if (url.pathname === '/__fake/health') {
      return json(res, 200, { ok: true, fake: true, format, cors: corsEnabled });
    }
    if (url.pathname === '/__fake/requests') {
      return json(res, 200, { count: requestLog.length, requests: getRequestLog() });
    }
    if (url.pathname === '/__fake/reset') {
      clearRequestLog();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__fake/cors') {
      setCorsEnabled(url.searchParams.get('on') === '1');
      return json(res, 200, { cors: corsEnabled });
    }

    // Record the request so tests can assert on headers and counts. Keys are recorded as PRESENCE
    // only: the fake must never store a credential value, even a fake one.
    if (req.method === 'POST') {
      let body = {};
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, 400, { error: String(e.message) });
      }
      const message = extractMessage(body);
      // WHY log the extracted message at all: this line exists because a Gemini request was being
      // routed to the model-listing branch, and the cause was an EMPTY extraction. Echoing it made
      // the mismatch obvious in one run instead of several. The fake stores no secrets, only the
      // text needed to debug and assert on request handling.
      requestLog.push({
        kind: 'chat',
        format,
        path: url.pathname,
        hasAuthorization: Boolean(req.headers.authorization),
        hasApiKeyHeader: Boolean(req.headers['x-api-key']),
        // WHY record the scheme only: the test asserts the key travels in a HEADER, never in a URL.
        authScheme: (req.headers.authorization ?? '').split(' ')[0] || null,
        query: message.slice(0, 120),
        at: Date.now(),
      });

      const fault = detectFaultMode(message);

      if (fault.mode === 'rate_limited') {
        return json(res, 429, { error: { message: 'fake rate limit', type: 'rate_limit_error' } }, { 'Retry-After': '1' });
      }
      if (fault.mode === 'server_error') return json(res, 500, { error: { message: 'fake server error' } });
      if (fault.mode === 'unauthorized') return json(res, 401, { error: { message: 'fake unauthorized' } });
      if (fault.mode === 'not_found') return json(res, 404, { error: { message: 'fake model not found' } });
      if (fault.mode === 'timeout') {
        // WHY never respond: the client's OWN timeout must be what fires. A fake that responded
        // would let a broken timeout pass unnoticed.
        return undefined;
      }

      const reply = message && !message.startsWith('__fake_')
        ? `${FAKE_MARKER_BODY} ${message}`
        : DEFAULT_REPLY;

      // WHY the substring is 'streamGenerateContent' and not 'generateContent': the real Gemini
      // method name is streamGenerateContent (capital G). A case-sensitive check for the
      // lowercased form never matches, so the request fell through to the 'models' branch and
      // every Gemini streaming call returned a model list instead of a stream. Caught by
      // "Gemini streams candidates/parts". Matching on the exact-cased substring keeps the
      // intent obvious and avoids a blind toLowerCase() over the whole path.
      if (url.pathname.includes('streamGenerateContent')
        || url.pathname.includes(':generateContent')) {
        return streamGemini(res, reply);
      }
      if (url.pathname.includes('models')) return handleModels(res, format);

      if (format === 'ollama') return streamOllama(res, reply, fault);
      if (format === 'anthropic') return streamAnthropic(res, reply, fault);
      return streamOpenAICompatible(res, reply, fault);
    }

    if (url.pathname.includes('/search')) return handleSearch(req, res, url);
    if (url.pathname.includes('models')) return handleModels(res, format);

    return json(res, 404, { error: 'fake provider: unknown path', fake: true });
  });

  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * Starts every fake server.
 *
 * WHY it refuses to start in production: a fake provider reachable from a production deployment
 * would serve fabricated answers that look real. The refusal is a hard error, not a warning, and it
 * is asserted by a test.
 *
 * @returns {{servers: object, close: () => Promise<void>, ports: object}}
 */
export function startAllFakeProviders(env = process.env) {
  const appEnv = env.APP_ENV ?? 'local';
  if (appEnv === 'production') {
    throw new Error(
      'REFUSING TO START: fake providers cannot run when APP_ENV=production. '
      + 'A fake provider in production would serve fabricated answers indistinguishable from real ones.',
    );
  }

  const ports = {
    openai: Number(env.FAKE_PROVIDERS_PORT ?? 8090),
    ollama: Number(env.FAKE_PROVIDERS_OLLAMA_PORT ?? 8091),
    anthropic: Number(env.FAKE_PROVIDERS_ANTHROPIC_PORT ?? 8092),
    gemini: Number(env.FAKE_PROVIDERS_GEMINI_PORT ?? 8093),
    search: Number(env.FAKE_PROVIDERS_SEARCH_PORT ?? 8094),
  };

  const servers = {
    openai: createFakeServer({ port: ports.openai, format: 'openai' }),
    ollama: createFakeServer({ port: ports.ollama, format: 'ollama' }),
    anthropic: createFakeServer({ port: ports.anthropic, format: 'anthropic' }),
    gemini: createFakeServer({ port: ports.gemini, format: 'gemini' }),
    search: createFakeServer({ port: ports.search, format: 'search' }),
  };

  const close = () => new Promise((resolve) => {
    let pending = Object.keys(servers).length;
    if (pending === 0) return resolve();
    for (const s of Object.values(servers)) {
      s.close(() => {
        pending -= 1;
        if (pending === 0) resolve();
      });
    }
    return undefined;
  });

  return { servers, close, ports };
}

// Run directly: `node ops/fake-providers/server.js`
const isMain = process.argv[1] && process.argv[1].endsWith('server.js');
if (isMain) {
  const { ports } = startAllFakeProviders();
  console.log('[fake-providers] FAKE servers started (test mode only):');
  for (const [name, port] of Object.entries(ports)) {
    console.log(`[fake-providers]   ${name.padEnd(10)} http://127.0.0.1:${port}`);
  }
}
  console.log('[fake-providers] Every response is tagged as fake. Do not use in production.');
