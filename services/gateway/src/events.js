/**
 * The SSE event vocabulary, shared with Python and with the browser.
 *
 * WHY these constructors exist: the event SHAPE is a contract, and building it by hand at each call
 * site is how a `retryable` field silently goes missing on the error path. Each constructor also
 * keeps `message_safe` short and secret-free by construction.
 *
 * ALTERNATIVES: a generic `emit(type, payload)` (rejected: it does not enforce required fields, so a
 * caller could emit an invalid event and the client would receive it).
 */
import { randomUUID } from 'node:crypto';

export const nowIso = () => new Date().toISOString();

/** Correlation id. WHY generated here and not in the browser: the AI service also logs it. */
export function newRequestId() {
  return randomUUID();
}

/** Provider/model labels for the badge. Never include a key, a URL with credentials, or an account. */
export function providerMeta({ bot, path, providerLabel, modelLabel, keySource, costLabel }) {
  return {
    type: 'meta',
    request_id: newRequestId(),
    meta: {
      bot,
      path,
      provider_label: String(providerLabel ?? 'unknown').slice(0, 120),
      model_label: String(modelLabel ?? 'unknown').slice(0, 160),
      ...(keySource ? { key_source: keySource } : {}),
      ...(costLabel ? { cost_label: String(costLabel).slice(0, 40) } : {}),
    },
  };
}

export function statusEvent(requestId, state, detail, nextStep) {
  return {
    type: 'status',
    request_id: requestId,
    status: {
      state,
      ...(detail ? { detail: String(detail).slice(0, 400) } : {}),
      ...(nextStep ? { next_step: String(nextStep).slice(0, 400) } : {}),
    },
  };
}

export function tokenEvent(requestId, text) {
  return { type: 'token', request_id: requestId, token: { text: String(text).slice(0, 8000) } };
}

export function sourceEvent(requestId, source) {
  return {
    type: 'source',
    request_id: requestId,
    source: {
      id: String(source.id ?? '').slice(0, 200),
      kind: source.kind,
      title: String(source.title ?? '').slice(0, 300),
      ...(source.locator ? { locator: String(source.locator).slice(0, 200) } : {}),
      ...(source.url ? { url: String(source.url).slice(0, 2048) } : {}),
      ...(source.snippet ? { snippet: String(source.snippet).slice(0, 1200) } : {}),
      ...(typeof source.score === 'number' ? { score: Math.max(0, Math.min(1, source.score)) } : {}),
    },
  };
}

/** tool_call is only ever emitted for bots 1 and 3. Bot 2 has no UI tools at all. */
export function toolCallEvent(requestId, name, args) {
  return { type: 'tool_call', request_id: requestId, tool_call: { name, args: args ?? {} } };
}

/**
 * WHY retryable is derived here and not left to the client: the server knows whether the failure was
 * transient. If the client decided, two implementations would eventually disagree about a 429 and
 * one of them would retry a quota error.
 */
const RETRYABLE_CODES = new Set(['provider_unavailable', 'rate_limited']);

export function errorEvent(requestId, code, messageSafe, { nextStep, retryable } = {}) {
  return {
    type: 'error',
    request_id: requestId,
    error: {
      code,
      // WHY a hard length cap: this string reaches the UI and may reach a log. It must never be
      // able to carry a stack trace, a prompt, or a secret.
      message_safe: String(messageSafe ?? 'Something went wrong.').slice(0, 600),
      retryable: retryable ?? RETRYABLE_CODES.has(code),
      ...(nextStep ? { next_step: String(nextStep).slice(0, 400) } : {}),
      request_id: requestId,
    },
  };
}

export function doneEvent(requestId, { prompt = 0, completion = 0, ttftMs = 0, totalMs = 0, truncated = false } = {}) {
  return {
    type: 'done',
    request_id: requestId,
    done: {
      usage: { prompt: Math.max(0, prompt | 0), completion: Math.max(0, completion | 0) },
      ttft_ms: Math.max(0, ttftMs | 0),
      total_ms: Math.max(0, totalMs | 0),
      ...(truncated ? { truncated: true } : {}),
    },
  };
}