import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  startAllFakeProviders, detectFaultMode, FAKE_MARKER, FAKE_MARKER_VALUE, getRequestLog, clearRequestLog,
} from '../ops/fake-providers/server.js';

/**
 * These tests exist to prove the FAKE is faithful enough to be useful. A fake that is easier than
 * the real thing produces tests that pass and production bugs that do not.
 */

let harness;
beforeAll(() => { harness = startAllFakeProviders({ APP_ENV: 'local' }); });
afterAll(async () => { await harness.close(); });

const port = (name) => harness.ports[name];

async function collectSse(url, init, { maxFrames = 400 } = {}) {
  const res = await fetch(url, init);
  const frames = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data:'));
      if (line) frames.push(line.slice(5).trim());
      if (frames.length >= maxFrames) break;
    }
    if (frames.length >= maxFrames) break;
  }
  return { status: res.status, headers: res.headers, frames };
}

const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('fake providers: safety rails', () => {
  test('refuses to start when APP_ENV=production', () => {
    // WHY this is a hard refusal, not a warning: a fake provider serving fabricated answers in a
    // production deployment is worse than no provider, because nothing downstream can tell.
    expect(() => startAllFakeProviders({ APP_ENV: 'production' })).toThrow(/REFUSING TO START/);
  });

  test('every response carries the fake marker header', async () => {
    // WHY this test exists: an earlier version used the whole header LINE as an object key, which
    // made Node throw ERR_INVALID_HTTP_TOKEN inside the server. Every response failed and the suite
    // hung instead of failing. Asserting the exact header pair pins the contract.
    const res = await fetch(`http://127.0.0.1:${port('openai')}/__fake/health`);
    expect(res.headers.get(FAKE_MARKER)).toBe(FAKE_MARKER_VALUE);
    expect(await res.json()).toMatchObject({ fake: true });
  });

  test('the health endpoint reports the format', async () => {
    const res = await fetch(`http://127.0.0.1:${port('anthropic')}/__fake/health`);
    expect((await res.json()).format).toBe('anthropic');
  });
});

describe('fake providers: OpenAI-compatible SSE', () => {
  test('streams multiple token frames then [DONE]', async () => {
    const { status, headers, frames } = await collectSse(
      `http://127.0.0.1:${port('openai')}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-key' },
        body: JSON.stringify({
          model: 'fake-model',
          stream: true,
          messages: [{ role: 'user', content: 'What has he built with Gen-AI?' }],
        }),
      },
    );
    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('text/event-stream');

    const parsed = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f));
    const contentFrames = parsed.filter((m) => m.choices?.[0]?.delta?.content);
    // WHY assert >= 3: E2E-09 requires the first token to arrive before completion, which needs a
    // genuinely chunked stream rather than one big frame.
    expect(contentFrames.length).toBeGreaterThanOrEqual(3);

    const text = contentFrames.map((m) => m.choices[0].delta.content).join('');
    expect(text).toContain('Gen-AI');
    expect(frames[frames.length - 1]).toBe('[DONE]');
  });

  test('reports usage before [DONE]', async () => {
    const { frames } = await collectSse(
      `http://127.0.0.1:${port('openai')}/v1/chat/completions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hello there friend' }] }) },
    );
    const withUsage = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f)).find((m) => m.usage);
    expect(withUsage.usage.prompt_tokens).toBe(42);
    expect(withUsage.usage.completion_tokens).toBeGreaterThan(0);
  });
});

describe('fake providers: fault injection', () => {
  test.each([
    ['__fake_429', 429],
    ['__fake_500', 500],
    ['__fake_401', 401],
    ['__fake_404', 404],
  ])('%s returns its status', async (marker, expected) => {
    // WHY each status matters: the gateway must classify 429 as retryable and 401/404 as NOT
    // retryable. A fake that only returned 500 would let a broken retry policy pass.
    const res = await postJson(`http://127.0.0.1:${port('openai')}/v1/chat/completions`, {
      model: 'm', messages: [{ role: 'user', content: marker }],
    });
    expect(res.status).toBe(expected);
  });

  test('429 includes Retry-After', async () => {
    const res = await postJson(`http://127.0.0.1:${port('openai')}/v1/chat/completions`, {
      model: 'm', messages: [{ role: 'user', content: '__fake_429' }],
    });
    expect(res.headers.get('retry-after')).toBe('1');
  });

  test('a mid-stream drop truncates instead of completing', async () => {
    // WHY the catch: res.destroy() is a REAL transport failure, so fetch rejects with
    // 'terminated' / SocketError. That rejection IS the proof that a mid-stream drop is
    // distinguishable from a completed stream -- if the fake ended cleanly instead, the client's
    // error handling would never be exercised.
    let frames = [];
    let threw = null;
    try {
      ({ frames } = await collectSse(
        `http://127.0.0.1:${port('openai')}/v1/chat/completions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '__fake_drop a b c d e f g h' }] }) },
      ));
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeNull();
    // Whatever arrived before the drop must NOT contain the completion sentinel.
    expect(frames.includes('[DONE]')).toBe(false);
  });

describe('fake providers: other wire formats', () => {
  test('Ollama uses newline-delimited JSON, not SSE', async () => {
    // WHY: an adapter written against SSE would parse nothing here. This proves the formats differ.
    const res = await postJson(`http://127.0.0.1:${port('ollama')}/api/chat`, {
      model: 'fake', messages: [{ role: 'user', content: 'hi there' }], stream: true,
    });
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('x-ndjson');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.response)).toBe(true);
    expect(lines[lines.length - 1].done).toBe(true);
  });

  test('Anthropic uses named SSE events', async () => {
    const res = await postJson(`http://127.0.0.1:${port('anthropic')}/v1/messages`, {
      model: 'claude-fake',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello world' }],
      stream: true,
    }, { 'x-api-key': 'fake', 'anthropic-version': '2023-06-01' });
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_stop');
    expect(text).toContain('text_delta');
  });

  test('Gemini streams candidates/parts', async () => {
    const res = await postJson(
      `http://127.0.0.1:${port('gemini')}/v1beta/models/fake-gemini:streamGenerateContent?alt=sse`,
      { contents: [{ parts: [{ text: 'gemini hello' }] }] },
    );
    const text = await res.text();
    expect(text).toContain('candidates');
    // WHY the words are asserted separately rather than as 'gemini hello': the fake streams one
    // token per frame, so the phrase is split across frames and never appears as one substring.
    // Asserting the concatenation is what actually proves the streamed text is correct.
    const words = [...text.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]).join('');
    expect(words).toContain('gemini hello');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  test.each([['openai'], ['ollama'], ['anthropic'], ['gemini']])('%s exposes a model list', async (fmt) => {
    const res = await fetch(`http://127.0.0.1:${port(fmt)}/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeTruthy();
  });
});

describe('fake providers: request recording and key safety', () => {
  test('records calls with header presence but never a key value', async () => {
    clearRequestLog();
    await postJson(`http://127.0.0.1:${port('openai')}/v1/chat/completions`, {
      model: 'm', messages: [{ role: 'user', content: 'recorded request' }],
    }, { Authorization: 'Bearer sk-super-secret-value' });
    const log = getRequestLog();
    const entry = log.find((r) => r.query === 'recorded request');
    expect(entry).toBeTruthy();
    expect(entry.hasAuthorization).toBe(true);
    expect(entry.authScheme).toBe('Bearer');
    // WHY: the fake must never retain a credential value, not even a fake one. A test double that
    // logs secrets into its own memory is a bad pattern to have in the repo.
    expect(JSON.stringify(log)).not.toContain('sk-super-secret-value');
  });

  test('search calls are counted, so zero-call assertions are possible', async () => {
    clearRequestLog();
    await fetch(`http://127.0.0.1:${port('search')}/search?q=hello`);
    expect(getRequestLog().filter((r) => r.kind === 'search')).toHaveLength(1);
  });
});

describe('fake providers: CORS toggle', () => {
  test('CORS can be turned off to exercise the browser failure path', async () => {
    const base = `http://127.0.0.1:${port('openai')}`;
    await fetch(`${base}/__fake/cors?on=0`);
    const off = await fetch(`${base}/v1/models`);
    expect(off.headers.get('access-control-allow-origin')).toBeNull();
    await fetch(`${base}/__fake/cors?on=1`);
    const on = await fetch(`${base}/v1/models`);
    expect(on.headers.get('access-control-allow-origin')).toBe('*');
  });
});
  test('detectFaultMode recognises every mode', () => {
    expect(detectFaultMode('__fake_429').mode).toBe('rate_limited');
    expect(detectFaultMode('__fake_drop').mode).toBe('midstream_drop');
    expect(detectFaultMode('__fake_slow').mode).toBe('slow');
    expect(detectFaultMode('hello').mode).toBe('normal');
  });
});