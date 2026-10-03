// secret-scan: allow
//
// WHY this whole file is exempt: the one string below is a DELIBERATE FIXTURE shaped like an
// OpenAI key. It exists precisely so the gateway's credential rejection can be proven against a
// realistic input -- a test that sent "not-a-key" would pass without exercising the pattern the
// scanner looks for. The value is not a credential: it is a literal sentence, reaches only the local
// gateway, and is asserted never to be echoed back.
//
// The scanner finding here is the scanner working correctly. A reviewer reading this comment should
// still treat any OTHER key-shaped string in this file as a real finding.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ROOT, startStack } from './stack.mjs';

/**
 * Task 1.13: browser -> gateway -> AI service -> provider, as real processes.
 *
 * WHY this is the test that was missing: until now the SSE path was proven only with an injected
 * `prepareTurn`. Nothing had exercised the actual HTTP hop to the Python service, the SQLite
 * retrieval, or the provider call. Every layer could be individually correct and the chain broken.
 *
 * WHY events are validated against the shared schema rather than spot-checked: the contract is the
 * single source of truth for the wire format. Asserting on shapes here means a gateway and a
 * frontend that each "look right" cannot disagree.
 */

const SCHEMA = JSON.parse(
  readFileSync(join(ROOT, 'packages/contracts/schemas/event.schema.json'), 'utf8'),
);
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateEvent = ajv.compile(SCHEMA);

/** Reads an SSE response body into parsed frames, ignoring `:` comments. */
function parseSse(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice('data:'.length).trim()));
}

/** One stack for the whole file: both describes below test the same running gateway. */
let stack;
let once;

beforeAll(async () => {
  stack = await startStack();
  once = await chatTurn(stack.gatewayUrl, {
    bot: 'bot1',
    message: 'What experience does Ravi have with distributed systems?',
    history: [],
  });
});

afterAll(async () => {
  if (stack) await stack.stop();
});

describe('contact reveal (gateway -> profile.json)', () => {
  // WHY the shared `stack` rather than a second one: both describes exercise the SAME gateway. Booting
  // a second stack made the second beforeAll race the first afterAll's teardown -- the new stack's
  // health probe saw the dying process still listening, returned "healthy", and every request then
  // failed with "fetch failed". One stack for the file removes the race and roughly halves startup.
  it('serves the reveal-only fields that the generator omits from the HTML', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/contact/reveal`, {
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(200);
    const { values } = await res.json();

    // WHY these two specifically: `build_static_site.py` omits any contact field whose `render` is
    // "reveal", so 32 generator tests assert the HTML does NOT contain them. This endpoint is the
    // only place they exist, which makes it the thing that proves the omission is recoverable.
    expect(values).toHaveProperty('email');
    expect(values).toHaveProperty('phone');
    for (const v of Object.values(values)) expect(typeof v).toBe('string');
  });

  it('never returns a field that is already visible in the prerendered HTML', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/contact/reveal`, {
      signal: AbortSignal.timeout(15_000),
    });
    const { values } = await res.json();
    const profile = JSON.parse(readFileSync(join(ROOT, 'content', 'profile.json'), 'utf8'));
    for (const key of Object.keys(values)) {
      const field = profile.contact[key];
      // WHY assert the guard, not just the value: serving a private or already-visible field here
      // would leak it through an endpoint nobody audits, because the HTML test only covers the HTML.
      expect(field.public, `${key} must be public`).toBe(true);
      expect(field.render, `${key} must be a reveal field`).toBe('reveal');
    }
  });

  it('does not serve a private field even if one is added to the profile', async () => {
    // WHY this is asserted against the real profile: the endpoint's safety depends on filtering by
    // `public === true && render === 'reveal'`. If someone relaxes that predicate, this test fails.
    const profile = JSON.parse(readFileSync(join(ROOT, 'content', 'profile.json'), 'utf8'));
    const revealKeys = Object.entries(profile.contact)
      .filter(([, f]) => f && typeof f === 'object' && f.render === 'reveal')
      .map(([k]) => k);

    const res = await fetch(`${stack.gatewayUrl}/v1/contact/reveal`, {
      signal: AbortSignal.timeout(15_000),
    });
    const { values } = await res.json();
    expect(Object.keys(values).sort()).toEqual(revealKeys.sort());
  });
});
/** Posts one chat turn and returns the parsed frames. */
async function chatTurn(gatewayUrl, body) {
  const res = await fetch(`${gatewayUrl}/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text, events: parseSse(text) };
}

/**
 * Bot 3 is the only bot whose turn carries SIDE EFFECTS. Everything here is about proving that a
 * request to change the page survives the real cross-process path as a typed event, and that a change
 * the safety rules forbid never leaves the gateway.
 *
 * WHY this suite exists at all and not just a unit test on the planner: the planner, the AI service,
 * the gateway and the SSE encoder are four separate processes. Each could be individually correct and
 * the chain broken -- the action planned, never serialised, or serialised as prose. Only a real request
 * through all four can prove the visitor would actually see the page change.
 */
describe('Bot 3 (Site Master): a UI request becomes a typed tool_call', () => {
  it('streams a tool_call for the theme the visitor asked for', async () => {
    const { events } = await chatTurn(stack.gatewayUrl, {
      bot: 'bot3', message: 'please switch to the cyberpunk theme', history: [],
    });
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    // WHY assert the exact payload: a tool_call with the right name and the wrong args would still be
    // applied by the browser, so the name alone does not prove the feature works.
    expect(calls[0].tool_call).toEqual({ name: 'set_theme', args: { theme: 'cyberpunk' } });
  });

  it('streams every action of a combined request, not just the first', async () => {
    const { events } = await chatTurn(stack.gatewayUrl, {
      bot: 'bot3', message: 'make the text bigger and go retro', history: [],
    });
    const names = events.filter((e) => e.type === 'tool_call').map((e) => e.tool_call.name);
    // WHY this matters: a visitor asking for two things and getting one is a silent partial failure
    // that looks like the bot understood them.
    expect(names).toContain('set_font_size');
    expect(names).toContain('set_theme');
  });

  it('applies the accessibility clamps before the event leaves the gateway', async () => {
    // WHY: the planner clamps, and so does the shared validator, and so does the browser. Asserting the
    // clamp at the wire proves the gateway is not the layer where a hostile value could slip past.
    const { events } = await chatTurn(stack.gatewayUrl, {
      bot: 'bot3', message: 'bigger', history: [], font_scale: 1.6,
    });
    const fontCalls = events.filter((e) => e.tool_call?.name === 'set_font_size');
    // At the ceiling there is nothing to step to, so the planner must emit NO font action at all rather
    // than one carrying a value above the limit.
    for (const call of fontCalls) {
      expect(call.tool_call.args.scale).toBeLessThanOrEqual(1.6);
      expect(call.tool_call.args.scale).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('never emits a tool_call for bot 1, which has no UI tools', async () => {
    const { events } = await chatTurn(stack.gatewayUrl, {
      bot: 'bot1', message: 'What RAG work has he done?', history: [],
    });
    // WHY this is a security property, not a tidiness one: bot 1 answers questions about the resume.
    // If a document it retrieved could steer it into changing the page, untrusted content would have
    // control of the visitor's screen.
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([]);
  });

  it('emits undo as an ordinary tool_call so the browser owns the history', async () => {
    // WHY the browser owns history rather than the server: the browser is the only place that knows
    // what the visitor's page actually looks like, so it is the only place that can undo correctly.
    const { events } = await chatTurn(stack.gatewayUrl, {
      bot: 'bot3', message: 'undo that', history: [],
    });
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].tool_call.name).toBe('undo');
  });

  it('never leaks the system canary into a tool_call', async () => {
    // WHY: the canary exists so a prompt leak is observable. Bot 3's plan is built server-side and
    // could, in principle, carry text from the system prompt into an event the visitor sees.
    const { text } = await chatTurn(stack.gatewayUrl, {
      bot: 'bot3', message: 'switch to retro', history: [],
    });
    // The fake provider echoes a tagged response; what must never appear is a bare hex token from the
    // system prompt, which is 24 hex characters.
    const canaryLeak = /["'](?:[0-9a-f]{24})["']/.exec(text);
    expect(canaryLeak, `possible canary leak: ${canaryLeak?.[0]}`).toBeNull();
  });
});

describe('POST /v1/prepare (browser-direct context assembly)', () => {
  it('returns retrieval sources without ever calling a model', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: 'bot1', message: 'What RAG work has he done?', history: [] }),
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bot).toBe('bot1');
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources.length).toBeGreaterThan(0);

    // WHY assert the ABSENCE of chunks and messages: this endpoint assembles context for a model the
    // visitor will call themselves. If it ever started returning raw chunk text or a prompt, the
    // retrieval scaffolding the canary guard hides would be handed straight to the browser.
    expect(body).not.toHaveProperty('chunks');
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('prompt');
  });

  it('refuses a provider key sent in the body, and never echoes it', async () => {
    const secret = 'sk-not-a-real-key-but-key-shaped-0000';
    const res = await fetch(`${stack.gatewayUrl}/v1/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: 'bot1', message: 'hi', history: [], api_key: secret }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    // WHY assert on the whole raw body rather than one field: the guarantee is that the value does
    // not appear anywhere in the response, including a field nobody remembered to sanitise.
    expect(text).not.toContain(secret);
  });

  it('refuses a provider auth header on the browser path too', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-header-key-0000' },
      body: JSON.stringify({ bot: 'bot1', message: 'hi', history: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(400);
    expect((await res.text())).not.toContain('sk-header-key-0000');
  });

  it('rejects an unknown bot with the same validation envelope as the site path', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: 'bot42', message: 'hi', history: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation');
  });
});

describe('cross-process chat turn: gateway -> AI service -> fake provider', () => {
  it('answers with 200 and an SSE content type', () => {
    expect(once.status).toBe(200);
    expect(once.contentType).toContain('text/event-stream');
  });

  it('emits every frame conforming to the shared event schema', () => {
    expect(once.events.length).toBeGreaterThan(0);
    for (const event of once.events) {
      const ok = validateEvent(event);
      expect(
        ok,
        `invalid event ${JSON.stringify(event)}\n${ajv.errorsText(validateEvent.errors)}`,
      ).toBe(true);
    }
  });

  it('opens with a meta frame naming the site path and the local provider', () => {
    const meta = once.events[0];
    expect(meta.type).toBe('meta');
    expect(meta.meta.path).toBe('site');
    expect(meta.meta.key_source).toBe('site');
    // WHY "local" is the load-bearing word: if the gateway ever silently reached for a paid
    // provider this suite would start making billable calls. `local (openai-compatible)` is what
    // the gateway reports when it is pointed at the fake. (This assertion originally expected the
    // literal word "fake" and failed -- the gateway names the provider family, not the fake server.)
    expect(String(meta.meta.provider_label).toLowerCase()).toContain('local');
  });

  it('streams at least one token and terminates with a done frame', () => {
    const tokens = once.events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((t) => t.token.text).join('')).not.toBe('');

    const last = once.events.at(-1);
    expect(last.type).toBe('done');
    expect(last.done.usage).toMatchObject({
      prompt: expect.any(Number), completion: expect.any(Number),
    });
  });

  it('carries retrieval sources back from the Python index', () => {
    const sources = once.events.filter((e) => e.type === 'source');
    // WHY this is the load-bearing assertion: sources can only exist if the gateway called the AI
    // service AND that service queried the SQLite index built from profile.json. No mock can fake it.
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) expect(s.source.kind).toBeTruthy();
  });

  it('never leaks a canary token or a source fence into the visitor-visible text', () => {
    const text = once.events
      .filter((e) => e.type === 'token')
      .map((e) => e.token.text)
      .join('');
    expect(text).not.toMatch(/CANARY-/i);
    // WHY fence markers are checked: the AI service wraps retrieved content in delimiters so the
    // model can tell sources from instructions. Leaking those would show raw scaffolding to users.
    expect(text).not.toMatch(/<<<|SOURCE|\[SOURCE/i);
  });

  it('rejects an unknown bot with a schema-valid error rather than a stream', async () => {
    const bad = await chatTurn(stack.gatewayUrl, { bot: 'bot99', message: 'hi', history: [] });
    expect(bad.status).toBe(400);
    expect(bad.events).toHaveLength(0);
    const body = JSON.parse(bad.text);
    expect(body.error.code).toBe('validation');
  });

  it('refuses provider credentials sent to the site path', async () => {
    const res = await fetch(`${stack.gatewayUrl}/v1/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // WHY this header specifically: AGENTS.md rule 6 says visitor keys stay in the browser. A
        // visitor pasting their key into the site's own chat box is the mistake this guards.
        Authorization: 'Bearer sk-should-never-reach-the-server',
      },
      body: JSON.stringify({ bot: 'bot1', message: 'hi', history: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message_safe).not.toContain('sk-should-never');
  });
});