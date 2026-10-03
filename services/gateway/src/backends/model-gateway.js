/**
 * Model Gateway (SITE PATH): the server-side LLM interface.
 *
 * WHY an interface here at all: there are three site-path providers (openrouter, azure_openai,
 * openai_compatible) with different wire formats, and three more browser-path providers. Orchestration
 * must not know which one is answering, or the RAG code would accumulate provider conditionals.
 *
 * ALTERNATIVES considered:
 *  - Call the provider SDK directly from the orchestrator (rejected: the orchestrator is the part
 *    that has to stay provider-agnostic; mixing them is how provider bugs get "fixed" in the wrong
 *    layer).
 *  - One universal OpenAI-compatible client (rejected: Anthropic and Gemini differ enough in
 *    framing, auth and tool calls that pretending otherwise produces subtle bugs).
 *
 * TRADE-OFF: `stream()` is an async generator of NORMALISED events, so every adapter converts its
 * own wire format into one vocabulary. That conversion is real work, but it is the work that makes
 * three chatbots and two execution paths possible without duplicating orchestration.
 */

/** Normalised stream events. Mirrors the contract event vocabulary minus status/source. */
export const MODEL_EVENT = {
  TOKEN: 'token',
  TOOL_CALL: 'tool_call',
  USAGE: 'usage',
  DONE: 'done',
};

export class ModelGatewayError extends Error {
  /**
   * @param {string} code one of the contract error codes
   * @param {string} safeMessage message safe to show a visitor
   * @param {{retryable?: boolean, nextStep?: string, cause?: Error}} [opts]
   */
  constructor(code, safeMessage, { retryable, nextStep, cause } = {}) {
    super(safeMessage);
    this.name = 'ModelGatewayError';
    this.code = code;
    this.safeMessage = safeMessage;
    // WHY retryable is decided HERE from the provider status, not by the caller: a 429 is
    // retryable, a 401 never is, and only this layer knows which happened.
    this.retryable = retryable
      ?? (code === 'provider_unavailable' || code === 'rate_limited');
    this.nextStep = nextStep;
    if (cause) this.cause = cause;
  }
}

/**
 * Maps an HTTP status from a provider to a typed error.
 *
 * WHY 401/403/404 are NOT retryable: retrying bad credentials or a missing model burns the daily
 * request budget and delays the visitor's "here is what to do next" message for nothing.
 */
export function classifyHttpStatus(status) {
  if (status === 429) {
    return new ModelGatewayError(
      'rate_limited',
      'The assistant is receiving too many requests right now. Please wait a moment and try again.',
      { nextStep: 'Wait about a minute, then try again.' },
    );
  }
  if (status === 401 || status === 403) {
    return new ModelGatewayError(
      'not_configured',
      'The site model is not configured correctly.',
      { retryable: false, nextStep: 'Open the model settings to use your own model instead.' },
    );
  }
  if (status === 404) {
    return new ModelGatewayError(
      'not_configured',
      'The configured model is not available.',
      { retryable: false, nextStep: 'Check the model name in the model settings.' },
    );
  }
  if (status >= 500) {
    return new ModelGatewayError(
      'provider_unavailable',
      'The assistant is temporarily unavailable. Please try again shortly.',
      { nextStep: 'Try again in a few seconds. If it keeps happening, use your own model.' },
    );
  }
  return new ModelGatewayError('internal', 'The assistant could not complete that request.');
}

/**
 * Parses an SSE byte stream into `{ data }` records.
 *
 * WHY written by hand rather than using an EventSource polyfill: EventSource is browser-only, and
 * this runs in Node behind a proxy that must be able to abort mid-stream. A hand-rolled parser also
 * makes the `[DONE]` sentinel and the multi-line `data:` case explicit rather than implicit.
 *
 * @param {AsyncIterable<Uint8Array>} body
 * @returns {AsyncGenerator<{data: string, event?: string}>}
 */
export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Frames are separated by a blank line. CRLF is tolerated because proxies rewrite line endings,
    // and a proxy that converts \n to \r\n must not break streaming.
    let match = buffer.match(/\r?\n\r?\n/);
    while (match) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      let data = '';
      let event;
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (data || event) yield { data, event };

      match = buffer.match(/\r?\n\r?\n/);
    }
  }

  // WHY the trailing flush: a final frame with no trailing blank line is legal, and dropping it
  // would lose the last token of every stream that ends exactly on a frame boundary.
  const tail = buffer.trim();
  if (tail) {
    const data = tail
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (data) yield { data };
  }
}

/**
 * OpenAI-compatible chat-completions adapter.
 *
 * WHY one adapter covers BOTH `openrouter` and a local `openai_compatible` server: they speak the
 * same protocol and differ only in base URL, key and model name. Two adapters would duplicate the
 * SSE parsing and the error mapping for no behavioural difference.
 *
 * @param {{baseUrl: string, apiKey?: string, model: string, label: string,
 *          costLabel?: string, timeoutMs?: number, maxOutputTokens?: number,
 *          fetchImpl?: typeof fetch}} opts
 */
export function createOpenAICompatibleAdapter(opts) {
  const {
    baseUrl, apiKey, model, label, costLabel,
    timeoutMs = 30000, maxOutputTokens = 800,
    fetchImpl = fetch,
  } = opts;

  if (!baseUrl) throw new Error('createOpenAICompatibleAdapter requires a baseUrl');
  if (!model) throw new Error('createOpenAICompatibleAdapter requires a model');

  return {
    providerLabel: label,
    modelLabel: model,
    costLabel,

    /**
     * @param {{messages: Array, temperature?: number, maxTokens?: number, tools?: Array,
     *          jsonMode?: boolean, signal?: AbortSignal}} request
     * @returns {AsyncGenerator<{type: string, [k: string]: any}>}
     */
    async *stream(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error('provider_timeout')), timeoutMs);

      // WHY the caller's signal is bridged rather than ignored: this is the hop where browser
      // cancellation actually has to reach the provider, and E2E-12 asserts that it does.
      const onAbort = () => controller.abort(request.signal?.reason ?? new Error('cancelled'));
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }

      let res;
      try {
        res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // WHY the key goes in a HEADER and never a query string: URLs land in proxy logs,
            // browser history and referrers. A key in a query string is a leaked key.
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: request.messages,
            stream: true,
            stream_options: { include_usage: true },
            temperature: request.temperature ?? 0.3,
            max_tokens: request.maxTokens ?? maxOutputTokens,
            ...(request.tools?.length ? { tools: request.tools, tool_choice: 'auto' } : {}),
            // WHY response_format is only added when asked for: sending it unconditionally makes
            // some models reject the request outright.
            ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timeout);
        // WHY abort-by-caller is not an error state: it is the visitor's Stop button, and it must
        // surface as Cancelled rather than Failed.
        if (request.signal?.aborted) {
          throw new ModelGatewayError('internal', 'Cancelled.', { retryable: false });
        }
        throw new ModelGatewayError(
          'provider_unavailable',
          'The assistant could not be reached.',
          { nextStep: 'Check your connection, or use your own model.', cause: e },
        );
      }

      if (!res.ok) {
        clearTimeout(timeout);
        throw classifyHttpStatus(res.status);
      }

      try {
        let usage = { prompt: 0, completion: 0 };
        for await (const frame of parseSse(res.body)) {
          const data = frame.data.trim();
          if (!data) continue;
          if (data === '[DONE]') break;

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            // WHY skip rather than throw: one malformed frame from a provider must not fail an
            // otherwise good answer. It is skipped, not silently "repaired".
            continue;
          }

          if (parsed?.usage) {
            usage = {
              prompt: parsed.usage.prompt_tokens ?? usage.prompt,
              completion: parsed.usage.completion_tokens ?? usage.completion,
            };
          }

          const delta = parsed?.choices?.[0]?.delta ?? {};
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: MODEL_EVENT.TOKEN, text: delta.content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              yield {
                type: MODEL_EVENT.TOOL_CALL,
                name: tc?.function?.name ?? '',
                // WHY the argument STRING is passed through rather than parsed here: providers
                // stream tool arguments in fragments, so JSON.parse on a partial fragment throws.
                // The caller accumulates and parses once the stream ends.
                argsJson: tc?.function?.arguments ?? '',
              };
            }
          }
        }
        yield { type: MODEL_EVENT.USAGE, usage };
        yield { type: MODEL_EVENT.DONE };
      } catch (e) {
        if (e instanceof ModelGatewayError) throw e;
        // A stream that dies mid-flight is a transport failure. Rethrowing is what makes the
        // degradation matrix's "mid-stream drop" row reachable.
        throw new ModelGatewayError(
          'provider_unavailable',
          'The connection to the assistant was interrupted.',
          { nextStep: 'Try again.', cause: e },
        );
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener?.('abort', onAbort);
      }
    },
  };
}

/**
 * Factory: resolves the configured site-path provider into an adapter.
 *
 * WHY a factory rather than a switch at the call site: business logic must depend on the interface
 * only, and this is the single place that reads LLM_PROVIDER.
 *
 * STATUS honesty (this is the whole point of labelling things):
 *  - `openai_compatible` (local Ollama / LM Studio / llama.cpp) -> Implemented and tested
 *  - `openrouter`                                                  -> Implemented and tested
 *  - `azure_openai`                                                -> Partially Implemented. The request
 *    shape is OpenAI-compatible, but Azure's auth form (`api-key` header), api-version query
 *    parameter and deployment-name-instead-of-model are NOT wired or tested, so it is NOT offered
 *    here and NOT claimed as working. See docs/16-local-first-backends.md.
 *
 * @param {object} config
 * @returns {{adapter: object|null, reason?: string, providerLabel: string, costLabel: string}}
 */
export function createModelGateway(config) {
  if (config.llmProvider === 'openai_compatible') {
    const label = 'Local (OpenAI-compatible)';
    if (!config.llmBaseUrl || !config.llmModel) {
      return {
        adapter: null,
        providerLabel: label,
        // WHY not just "FREE": a local server costs the visitor no money but does consume their
        // electricity and GPU time. Saying FREE without that would be misleading.
        costLabel: 'FREE (runs on your machine)',
        reason: 'LLM_PROVIDER=openai_compatible needs LLM_BASE_URL and LLM_MODEL. '
          + 'Set them, or choose another model in the model settings.',
      };
    }
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: config.llmBaseUrl,
      apiKey: config.secrets.LLM_API_KEY,
      model: config.llmModel,
      label,
      costLabel: 'FREE (runs on your machine)',
      timeoutMs: config.llmTimeoutMs,
      maxOutputTokens: config.llmMaxOutputTokens,
    });
    return { adapter, providerLabel: label, costLabel: 'FREE (runs on your machine)' };
  }

  if (config.llmProvider === 'openrouter') {
    const label = 'OpenRouter';
    const key = config.secrets.OPENROUTER_API_KEY;
    const model = config.openrouterModel;
    if (!key || !model) {
      // WHY a null adapter instead of a crash: `verify` must run with zero credentials, and the UI
      // must be able to state exactly what is missing and offer the model switcher. This message is
      // the one E2E-36 asserts on.
      return {
        adapter: null,
        providerLabel: label,
        costLabel: 'UNKNOWN',
        reason: !key && !model
          ? 'Site model unavailable: no model configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL, '
            + 'or choose your own model below.'
          : !key
            ? 'Site model unavailable: OPENROUTER_API_KEY is not set. '
              + 'Set it, or choose your own model below.'
            : 'Site model unavailable: OPENROUTER_MODEL is not set. '
              + 'Set it, or choose your own model below.',
      };
    }
    const adapter = createOpenAICompatibleAdapter({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: key,
      model,
      label,
      // WHY UNKNOWN and not a price: the actual cost depends on the model, and claiming a figure
      // here without checking the provider would violate the honesty rule.
      costLabel: 'UNKNOWN (depends on the model)',
      timeoutMs: config.llmTimeoutMs,
      maxOutputTokens: config.llmMaxOutputTokens,
    });
    return { adapter, providerLabel: label, costLabel: 'UNKNOWN (depends on the model)' };
  }

  if (config.llmProvider === 'azure_openai') {
    return {
      adapter: null,
      providerLabel: 'Azure OpenAI',
      costLabel: 'PAID',
      reason: 'LLM_PROVIDER=azure_openai is Partially Implemented: the adapter is not yet wired or '
        + 'tested, so it is not offered. Use LLM_PROVIDER=openrouter or openai_compatible.',
    };
  }

  return {
    adapter: null,
    providerLabel: 'unknown',
    costLabel: 'UNKNOWN',
    reason: `Unknown LLM_PROVIDER: ${config.llmProvider}`,
  };
}
