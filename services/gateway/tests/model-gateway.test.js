import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startAllFakeProviders, clearRequestLog, getRequestLog } from '../../../ops/fake-providers/server.js';
import {
  createOpenAICompatibleAdapter, createModelGateway, parseSse, classifyHttpStatus,
  MODEL_EVENT, ModelGatewayError,
} from '../src/backends/model-gateway.js';
import { loadConfig } from '../src/config.js';

let fake;
beforeAll(() => { fake = startAllFakeProviders({ APP_ENV: 'local' }); });
afterAll(async () => { await fake.close(); });
beforeEach(() => clearRequestLog());

const OPENAI_BASE = () => `http://127.0.0.1:${fake.ports.openai}/v1`;

const adapter = () => createOpenAICompatibleAdapter({
  baseUrl: OPENAI_BASE(),
  model: 'fake-model',
  label: 'Fake OpenAI',
  costLabel: 'FREE (test)',
  timeoutMs: 10000,
});

async function collect(gen) {
  const tokens = [];
  const tools = [];
  let usage = null;
  let done = false;
  for await (const e of gen) {
    if (e.type === MODEL_EVENT.TOKEN) tokens.push(e.text);
    else if (e.type === MODEL_EVENT.TOOL_CALL) tools.push(e);
    else if (e.type === MODEL_EVENT.USAGE) usage = e.usage;
    else if (e.type === MODEL_EVENT.DONE) done = true;
  }
  return { text: tokens.join(''), tokens, tools, usage, done };
}

describe('Model Gateway: streamed round trip against the fake provider', () => {
  test('yields tokens, usage and done', async () => {
    const r = await collect(adapter().stream({
      messages: [{ role: 'user', content: 'What has he built with Gen-AI?' }],
    }));
    // WHY >= 3 tokens: E2E-09 requires a genuinely chunked stream so first-token latency is
    // measurable and rendering is proven incremental.
    expect(r.tokens.length).toBeGreaterThanOrEqual(3);
    expect(r.text).toContain('Gen-AI');
    expect(r.usage.prompt).toBe(42);
    expect(r.done).toBe(true);
  });

  test('sends the API key in a header, never in the URL', async () => {
    const a = createOpenAICompatibleAdapter({
      baseUrl: OPENAI_BASE(), apiKey: 'sk-test-value', model: 'm', label: 'l',
    });
    await collect(a.stream({ messages: [{ role: 'user', content: 'key placement check' }] }));
    const log = getRequestLog();
    const entry = log.find((r) => r.query === 'key placement check');
    expect(entry.hasAuthorization).toBe(true);
    expect(entry.authScheme).toBe('Bearer');
    // WHY assert the recorded path carries no query string: a key in a query string ends up in proxy
    // logs and referrers. The fake records the path, so a query would be visible here.
    expect(entry.path).not.toContain('?');
    expect(JSON.stringify(log)).not.toContain('sk-test-value');
  });
});

describe('Model Gateway: cancellation really aborts upstream', () => {
  test('an aborted signal stops the stream promptly', async () => {
    const controller = new AbortController();
    const received = [];
    let threw = null;
    try {
      for await (const e of adapter().stream({
        messages: [{ role: 'user', content: '__fake_slow counting one two three four five six seven' }],
        signal: controller.signal,
      })) {
        if (e.type === MODEL_EVENT.TOKEN) {
          received.push(e.text);
          if (received.length === 2) controller.abort();
        }
      }
    } catch (err) {
      threw = err;
    }
    // WHY assert it THREW rather than "stopped quietly": a quiet stop would let the UI render a
    // partial answer as though it were complete. Cancelled must be an explicit terminal state.
    expect(threw).toBeInstanceOf(ModelGatewayError);
    expect(received.length).toBeLessThan(7);
  });

  test('an already-aborted signal never issues a request', async () => {
    const controller = new AbortController();
    controller.abort();
    let threw = null;
    try {
      await collect(adapter().stream({
        messages: [{ role: 'user', content: 'should never be sent' }],
        signal: controller.signal,
      }));
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(ModelGatewayError);
    const log = getRequestLog();
    // WHY: the fake logs every request it receives, so "never issued" is directly observable.
    expect(log.some((r) => r.query === 'should never be sent')).toBe(false);
  });
});

describe('Model Gateway: error mapping', () => {
  test.each([
    ['__fake_429', 'rate_limited', true],
    ['__fake_500', 'provider_unavailable', true],
    ['__fake_401', 'not_configured', false],
    ['__fake_404', 'not_configured', false],
  ])('%s maps to %s', async (marker, code, retryable) => {
    // WHY the retryable column is asserted: retrying a 401 or 404 wastes budget and delays the
    // "here is what to do next" message. Only transient failures may auto-retry.
    let threw = null;
    try {
      await collect(adapter().stream({ messages: [{ role: 'user', content: marker }] }));
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(ModelGatewayError);
    expect(threw.code).toBe(code);
    expect(threw.retryable).toBe(retryable);
    expect(threw.safeMessage.length).toBeLessThanOrEqual(600);
  });

  test('a mid-stream drop becomes provider_unavailable, not a short answer', async () => {
    // WHY: a truncated stream that looks like a complete answer is a correctness bug.
    let threw = null;
    try {
      await collect(adapter().stream({
        messages: [{ role: 'user', content: '__fake_drop a b c d e f g h i j k' }],
      }));
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(ModelGatewayError);
    expect(threw.code).toBe('provider_unavailable');
  });

  test('a timeout produces a retryable provider_unavailable', async () => {
    const a = createOpenAICompatibleAdapter({
      baseUrl: OPENAI_BASE(), model: 'm', label: 'l', timeoutMs: 300,
    });
    let threw = null;
    try {
      await collect(a.stream({ messages: [{ role: 'user', content: '__fake_timeout' }] }));
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(ModelGatewayError);
    expect(threw.code).toBe('provider_unavailable');
    expect(threw.retryable).toBe(true);
  });

  test('classifyHttpStatus is total and never marks auth errors retryable', () => {
    for (const s of [200, 400, 401, 403, 404, 429, 500, 503]) {
      expect(() => classifyHttpStatus(s)).not.toThrow();
describe('Model Gateway: factory and unconfigured state', () => {
  test('zero-credential openrouter yields no adapter and an actionable reason', () => {
    // WHY this is THE zero-credential behaviour (E2E-36): the app must start and chat must report a
    // precise reason plus an offer of the switcher, rather than crashing.
    const gw = createModelGateway(loadConfig({ APP_ENV: 'local', LLM_PROVIDER: 'openrouter' }));
    expect(gw.adapter).toBeNull();
    expect(gw.reason).toMatch(/no model configured/i);
    expect(gw.providerLabel).toBe('OpenRouter');
  });

  test('a key without a model names the missing key', () => {
    const config = loadConfig({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' });
    expect(createModelGateway(config).reason).toMatch(/OPENROUTER_MODEL/);
  });

  test('a model without a key names the missing key', () => {
    const config = loadConfig({ LLM_PROVIDER: 'openrouter', OPENROUTER_MODEL: 'm' });
    expect(createModelGateway(config).reason).toMatch(/OPENROUTER_API_KEY/);
  });

  test('openai_compatible without a base url is refused, naming both keys', () => {
    const gw = createModelGateway(loadConfig({ LLM_PROVIDER: 'openai_compatible' }));
    expect(gw.adapter).toBeNull();
    expect(gw.reason).toMatch(/LLM_BASE_URL/);
    expect(gw.reason).toMatch(/LLM_MODEL/);
  });

  test('openai_compatible with a base url and model produces a working adapter', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'openai_compatible',
      LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: 'llama3.1',
    });
    const gw = createModelGateway(config);
    expect(gw.adapter).not.toBeNull();
    // WHY assert the cost wording: "FREE" alone would hide that it consumes the visitor's own
    // electricity and GPU time.
    expect(gw.costLabel).toMatch(/your machine/i);
  });

  test('azure_openai is honestly reported as not yet wired', () => {
    // WHY: claiming Implemented for an adapter that is not tested would be exactly the dishonesty
    // this project forbids.
    const config = loadConfig({
      LLM_PROVIDER: 'azure_openai',
      AZURE_OPENAI_ENDPOINT: 'https://x', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_CHAT_DEPLOYMENT: 'd',
    });
    const gw = createModelGateway(config);
    expect(gw.adapter).toBeNull();
    expect(gw.reason).toMatch(/Partially Implemented/i);
  });

  test('an unknown provider is refused rather than silently defaulted', () => {
    // WHY NOT fall back to openrouter: a silent provider switch is forbidden, and would spend money
    // the operator did not choose to spend.
    const config = loadConfig({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'm' });
    config.llmProvider = 'not-a-provider';
    expect(createModelGateway(config).adapter).toBeNull();
  });
});

describe('SSE parser', () => {
  test('handles CRLF, split chunks and a missing trailing blank line', async () => {
    const body = (async function* gen() {
      // WHY CRLF and mid-frame chunk splits: a proxy rewriting line endings, or a chunk boundary
      // landing inside a frame, must not corrupt the stream. Both are common; both break naive
      // parsers.
      yield new TextEncoder().encode('data: {"a":1}\r\n\r\ndata: {"b"');
      yield new TextEncoder().encode(':2}\r\n\r\ndata: {"c":3}');
    })();
    const out = [];
    for await (const f of parseSse(body)) out.push(f.data);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('yields the event name when present', async () => {
    const body = (async function* gen() {
      yield new TextEncoder().encode('event: ping\ndata: {"x":1}\n\n');
    })();
    const frames = [];
    for await (const f of parseSse(body)) frames.push(f);
    expect(frames[0].event).toBe('ping');
  });
});
    }
    expect(classifyHttpStatus(401).retryable).toBe(false);
    expect(classifyHttpStatus(429).retryable).toBe(true);
  });
});
