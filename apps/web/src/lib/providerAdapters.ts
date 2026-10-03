/**
 * Browser-direct provider adapters.
 *
 * THE SECURITY MODEL, stated once because everything here depends on it: when a visitor supplies
 * their own key, that key is used by THIS module, in the visitor's browser, against the visitor's
 * chosen provider. It is never sent to the gateway, never written to a log, and never persisted
 * anywhere the server can read. The gateway's only role on this path is to assemble context
 * (`POST /v1/prepare`), which requires no credential at all.
 *
 * WHY that matters for CSP: the gateway's `connect-src` explicitly lists the provider origins
 * (see middleware/security.js) precisely so these requests are permitted. A provider NOT on that
 * list is blocked by the browser, not by us -- which is the intended outcome, not a bug to route
 * around.
 *
 * WHY local URLs are allowed here but restricted on the server: a visitor running Ollama on their
 * own machine is the single most common "use my own key" case, and the SSRF guard in
 * url-guard.js protects the SERVER from being used as a proxy. In the visitor's own browser that
 * threat does not exist, because they are already the one making the request.
 */

export interface ProviderAdapter {
  id: string;
  label: string;
  /** TRUE when the visitor's request leaves their machine for a third party. */
  isRemote: boolean;
  defaultModel: string;
  /** Human cost label. Shown verbatim in the UI so the visitor is never guessing. */
  costLabel: string;
  buildRequest(question: string, apiKey: string, model: string): {
    url: string;
    init: RequestInit;
  };
  /** Pulls the assistant text out of one streamed chunk; returns '' for non-text chunks. */
  parseChunk(chunk: string): string;
}

const json = (body: unknown): RequestInit['body'] => JSON.stringify(body);

export const ADAPTERS: ProviderAdapter[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    isRemote: true,
    defaultModel: 'gpt-4o-mini',
    costLabel: 'PAID \u2014 your key, billed by OpenAI',
    buildRequest: (question, apiKey, model) => ({
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: json({
          model,
          messages: [{ role: 'user', content: question }],
          stream: true,
          max_tokens: 800,
        }),
      },
    }),
    // WHY the `?` chain: an SSE line can be a comment, a blank, or a `[DONE]` sentinel. Each must
    // yield '' rather than throwing, or one uninteresting line kills the stream.
    parseChunk: (chunk) => {
      const data = chunk.replace(/^data:\s*/, '').trim();
      if (!data || data === '[DONE]') return '';
      try {
        const json_ = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        return json_.choices?.[0]?.delta?.content ?? '';
      } catch {
        return '';
      }
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    isRemote: true,
    defaultModel: 'claude-3-5-haiku-latest',
    costLabel: 'PAID \u2014 your key, billed by Anthropic',
    buildRequest: (question, apiKey, model) => ({
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          // WHY a pinned version header: the Anthropic API requires it, and pinning it means a
          // default change on their side cannot silently alter what this adapter sends.
          'anthropic-version': '2023-06-01',
        },
        body: json({
          model,
          max_tokens: 800,
          stream: true,
          messages: [{ role: 'user', content: question }],
        }),
      },
    }),
    parseChunk: (chunk) => {
      const data = chunk.replace(/^data:\s*/, '').trim();
      if (!data) return '';
      try {
        const json_ = JSON.parse(data) as {
          type?: string; delta?: { type?: string; text?: string };
        };
        // WHY filter on type: Anthropic emits content_block_start / content_block_stop events that
        // carry no text. Rendering them would inject control tokens into the answer.
        return json_.type === 'content_block_delta' ? (json_.delta?.text ?? '') : '';
      } catch {
        return '';
      }
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    // WHY NOT remote: this never leaves the machine, so it costs nothing and is not a data egress.
    isRemote: false,
    defaultModel: 'llama3.1',
    costLabel: 'FREE \u2014 runs on your own machine',
    buildRequest: (question, _apiKey, model) => ({
      url: 'http://localhost:11434/api/chat',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // WHY an empty string rather than a dummy key: Ollama ignores it, and writing a fake
        // credential here would put a key-shaped string in the bundle for no reason.
        body: json({ model, stream: true, messages: [{ role: 'user', content: question }] }),
      },
    }),
    parseChunk: (chunk) => {
      const data = chunk.trim();
      if (!data) return '';
      try {
        return (JSON.parse(data) as { message?: { content?: string } }).message?.content ?? '';
      } catch {
        return '';
      }
    },
  },
];

export function adapterById(id: string): ProviderAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}