import type { ProviderAdapter } from './providerAdapters';

/**
 * The browser-direct chat path (BYOK).
 *
 * THE INVARIANT THIS FILE ENFORCES: the visitor's API key is used here, in this module, and goes to
 * exactly one place -- the provider's own endpoint. It is NOT sent to this project's gateway, not
 * written to storage, and not included in any log. The gateway is called once, for context only, and
 * that request carries no credential at all.
 *
 * WHY this exists alongside the site path: the site path is free and needs no key; this path lets a
 * visitor use a model they already pay for. Both assemble context through the SAME gateway endpoint,
 * so the answers differ only in which model wrote them.
 */
const PREPARE_ENDPOINT = '/api/v1/prepare';

export interface BrowserChatRequest {
  adapter: ProviderAdapter;
  apiKey: string;
  model: string;
  bot: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Raised when the provider itself failed, with a message safe to show a visitor. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | 0,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

interface PreparedContext {
  sources: Array<{ id: string; title: string; locator?: string }>;
}

/**
 * Assembles context from the gateway. Carries NO credential by construction: the object literal below
 * has exactly three fields, so a future edit that added `apiKey` here would be visible in review and
 * would fail the gateway's own credential rejection test.
 */
async function prepareContext(body: BrowserChatRequest, signal: AbortSignal): Promise<PreparedContext> {
  const res = await fetch(PREPARE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ bot: body.bot, message: body.message, history: body.history ?? [] }),
    signal,
  });
  if (!res.ok) {
    // WHY a distinct failure mode: the gateway can refuse while the provider is perfectly reachable.
    // Telling the visitor "the provider failed" here would send them debugging the wrong system.
    throw new ProviderError('this site', res.status, 'Source search is unavailable, so this answer may be incomplete.');
  }
  const json = await res.json() as PreparedContext;
  return { sources: Array.isArray(json?.sources) ? json.sources : [] };
}

/**
 * Runs one browser-direct turn, calling the provider directly and streaming its tokens back.
 *
 * @param onToken   called per streamed token fragment.
 * @param onSources called once with the citations from the gateway.
 */
export async function runBrowserChat(
  request: BrowserChatRequest,
  onToken: (text: string) => void,
  onSources: (sources: PreparedContext['sources']) => void,
  signal: AbortSignal,
): Promise<void> {
  const sources = await prepareContext(request, signal);
  onSources(sources.sources);

  const { adapter, apiKey, model, message } = request;
  const { url, init } = adapter.buildRequest(message, apiKey, model);

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    // WHY this specific message: the overwhelmingly common cause here is a CSP block or a local
    // server that is not running, and both look identical to the browser. Say which two things to
    // check rather than reporting a generic network failure.
    throw new ProviderError(adapter.label, 0,
      `Could not reach ${adapter.label}. If this is a local model, check that it is running. `
      + 'The browser may also have blocked the request (see the console).');
  }

  if (!res.ok) {
    // WHY never surface res.text(): a provider error body can echo the API key. Only the status and a
    // fixed explanation are safe, and 401/403 get the one actionable hint worth giving.
    const hint = res.status === 401 || res.status === 403
      ? ' The provider rejected the key.'
      : res.status === 429
        ? ' The provider is rate limiting this key.'
        : '';
    throw new ProviderError(adapter.label, res.status, `${adapter.label} returned HTTP ${res.status}.${hint}`);
  }
  if (!res.body) throw new ProviderError(adapter.label, 0, 'The provider returned no response body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // WHY newline-delimited rather than blank-line-delimited: Ollama streams one JSON object per line
    // with no blank separator, while OpenAI/Anthropic use `data:` frames. Splitting on \n and letting
    // each adapter's parseChunk ignore what it does not recognise handles both in one loop.
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const text = adapter.parseChunk(line);
      if (text) onToken(text);
      nl = buffer.indexOf('\n');
    }
  }

  // WHY drain the remainder: a final frame often arrives without a trailing newline, and dropping it
  // would silently truncate the last word of every answer.
  const tail = adapter.parseChunk(buffer);
  if (tail) onToken(tail);
}