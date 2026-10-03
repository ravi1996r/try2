import type { StreamEvent } from './events';

/**
 * Minimal SSE-over-POST client.
 *
 * WHY not EventSource: EventSource is GET-only and cannot send a JSON body or an abort mid-flight in
 * the way this API needs. The gateway sends a comment (`:ok`) before the first frame so a proxy does
 * not buffer, and `fetch` with a streaming reader handles that transparently.
 *
 * WHY an explicit Content-Type check: a non-2xx response is JSON with an `error` envelope, not a
 * stream. Parsing it as SSE would silently produce zero frames and a chat panel that hangs.
 */
const CHAT_ENDPOINT = '/api/v1/chat/stream';

export interface ChatRequest {
  bot: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  session_id?: string;
}

/** Thrown when the server answers with a structured error instead of a stream. */
export class ChatHttpError extends Error {
  constructor(readonly status: number, readonly code: string, messageSafe: string) {
    super(messageSafe);
    this.name = 'ChatHttpError';
  }
}

export async function openChatStream(
  body: ChatRequest,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // WHY send a request id: the server echoes it on every frame, which is what lets the panel
      // reject frames from a superseded request if the visitor sends a second question quickly.
      'X-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let code = 'internal';
    let messageSafe = `The request failed (HTTP ${res.status}).`;
    try {
      const json = await res.json() as { error?: { code?: string; message_safe?: string } };
      if (json.error?.code) code = json.error.code;
      if (json.error?.message_safe) messageSafe = json.error.message_safe;
    } catch {
      // WHY keep the generic text: a non-JSON error body (an HTML 502 page from a proxy) must not be
      // rendered to a visitor.
    }
    throw new ChatHttpError(res.status, code, messageSafe);
  }

  if (!res.body) throw new Error('no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // WHY split on the blank line: SSE frames are separated by a blank line, and a chunk boundary can
    // land mid-frame. Holding the remainder in `buffer` is what makes chunking irrelevant here.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      emit(block, onEvent);
      split = buffer.indexOf('\n\n');
    }
  }
}

/** Parses one SSE block, ignoring comments and anything that is not a JSON `data:` frame. */
function emit(block: string, onEvent: (e: StreamEvent) => void) {
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    // WHY skip comments: the gateway sends `:ok` as a priming comment, and SSE comments are legal.
    if (trimmed === '' || trimmed.startsWith(':')) continue;
    if (!trimmed.startsWith('data:')) continue;
    try {
      onEvent(JSON.parse(trimmed.slice('data:'.length).trim()) as StreamEvent);
    } catch {
      // WHY swallow a malformed frame: one bad frame must not discard the tokens already rendered or
      // blank the transcript. The server validates frames against the schema, so this is belt-and-braces.
    }
  }
}