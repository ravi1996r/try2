/**
 * StreamEvent: the browser's mirror of packages/contracts/schemas/event.schema.json.
 *
 * WHY this is a hand-written mirror rather than a generated type: the schema is the single source of
 * truth, and a codegen step would add a build dependency for ~40 lines. The cost is that this file
 * can drift, which `tests/web-events.test.ts` guards by parsing both and comparing the frame types and
 * event names.
 */
export type StreamEvent =
  | { type: 'meta'; request_id: string; meta: { bot: string; path: string; provider_label: string; model_label: string; key_source?: string; cost_label?: string } }
  | { type: 'status'; request_id: string; status: { state: string; detail?: string; next_step?: string } }
  | { type: 'token'; request_id: string; token: { text: string } }
  | { type: 'source'; request_id: string; source: { id: string; kind: string; title: string; locator?: string; url?: string; snippet?: string; score?: number } }
  | { type: 'tool_call'; request_id: string; tool_call: { name: string; args: Record<string, unknown> } }
  | { type: 'error'; request_id: string; error: { code: string; message_safe: string; retryable: boolean; next_step?: string } }
  | { type: 'done'; request_id: string; done: { usage: { prompt: number; completion: number }; ttft_ms: number; total_ms?: number; truncated?: boolean } };

/** The frame types the schema permits. Mirrored in the drift test. */
export const EVENT_TYPES = [
  'meta', 'status', 'token', 'source', 'tool_call', 'error', 'done',
] as const;

/** Status states the schema permits. */
export const STATUS_STATES = [
  'queued', 'processing', 'retrieving', 'streaming', 'retrying',
  'completed', 'failed', 'cancelled', 'timed_out',
] as const;

/** Error codes the schema permits. */
export const ERROR_CODES = [
  'validation', 'provider_unavailable', 'quota_exceeded', 'context_limit',
  'retrieval_failure', 'rate_limited', 'budget_exhausted', 'not_configured', 'internal',
] as const;