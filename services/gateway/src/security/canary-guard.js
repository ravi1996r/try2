/**
 * Incremental canary detection for a token stream.
 *
 * THE PROBLEM THIS SOLVES
 * The AI service plants a random token (the canary) in the system prompt on every Bot 1 request. If
 * the model echoes its instructions, that token appears in the output, and rendering it hands the
 * visitor the system prompt. So the gateway must never emit a canary character to the client.
 *
 * The previous implementation buffered the ENTIRE response, checked it, then sent one token frame.
 * That is safe but wrong in a way the requirements call out explicitly: it destroys first-token
 * latency and the browser cannot render progressively. It also means a slow model shows nothing at
 * all until it finishes.
 *
 * WHY A FULL BUFFER IS NOT NECESSARY
 * A canary is a fixed, known string. It can only ever appear if the model emits those exact bytes.
 * So we do not need to wait for the whole response to know whether a *specific position* is safe:
 * we only need to hold back a small suffix while a partial match at the tail is still possible.
 *
 * THE ALGORITHM
 * Maintain a carry buffer of at most `canary.length - 1` characters. On each incoming chunk:
 *   1. Append the chunk to the carry.
 *   2. If the canary is present in that window, the leak is detected -- report it immediately.
 *   3. Otherwise emit everything except the last `canary.length - 1` characters, and keep those
 *      as the new carry.
 *
 * WHY THE CARRY IS EXACTLY canary.length - 1
 * That is the longest suffix of the stream that could still grow into the canary. Holding back one
 * fewer character could let the first byte of a canary reach the client; holding back more would
 * delay the tail of every response for no safety gain. This is the tightest correct bound.
 *
 * WHY THIS IS STRICTLY BETTER THAN BUFFERING
 *   * First token is forwarded after one chunk instead of after the whole response.
 *   * A leak is caught at the moment it completes, and the already-emitted text is still bounded by
 *     the same MAX_BUFFERED ceiling, so a runaway stream cannot grow memory without limit.
 *   * Nothing is silently truncated: overflow and leak are distinct, separately reported outcomes.
 */

/** Default hard ceiling on emitted characters, so a model ignoring max_tokens cannot exhaust memory. */
export const MAX_BUFFERED = 20000;

/**
 * Creates a streaming canary guard.
 *
 * @param {string|null} canary  the token to detect, or null/empty to disable the guard entirely.
 * @param {object} [opts]
 * @param {number} [opts.maxLength] total character ceiling before the response is abandoned.
 * @returns {{ push(chunk: string): {emit: string, leak: boolean, overflow: boolean},
 *            finish(): {emit: string, leak: boolean, overflow: boolean},
 *            get emitted(): number }}
 */
export function createCanaryGuard(canary, opts = {}) {
  const maxLength = opts.maxLength ?? MAX_BUFFERED;
  // WHY `enabled`: a request with no canary (Bot 2, Bot 3, or a failure before prepare) must stream
  // with zero latency and zero buffering. Holding text back when there is nothing to detect would be
  // a pointless tax on every non-Bot-1 response.
  const enabled = typeof canary === 'string' && canary.length > 0;
  // -1 so a single-character canary still needs to be held: it would otherwise be undetectable
  // because any char could be it.
  const holdBack = enabled ? canary.length - 1 : 0;

  let carry = '';
  let emitted = 0;
  let overflow = false;

  function push(chunk) {
    if (overflow) return { emit: '', leak: false, overflow: true };

    const window = carry + (chunk ?? '');

    // Signal 1: the canary completed inside this window. Detect BEFORE emitting, so not one
    // character of a leaked canary has been sent.
    if (enabled && window.includes(canary)) {
      return { emit: '', leak: true, overflow: false };
    }

    // Signal 2: the response is implausibly long. Abort rather than truncate: an over-long response
    // is itself a signal, and silently dropping the tail would hide it.
    if (emitted + window.length > maxLength) {
      overflow = true;
      return { emit: '', leak: false, overflow: true };
    }

    const cut = Math.max(0, window.length - holdBack);
    const emit = window.slice(0, cut);
    carry = window.slice(cut);
    emitted += emit.length;
    return { emit, leak: false, overflow: false };
  }

  function finish() {
    if (overflow) return { emit: '', leak: false, overflow: true };
    // WHY re-check on finish: the carry was never emitted, so the canary may complete inside it.
    if (enabled && carry.includes(canary)) {
      return { emit: '', leak: true, overflow: false };
    }
    const emit = carry;
    carry = '';
    emitted += emit.length;
    return { emit, leak: false, overflow: false };
  }

  return { push, finish, get emitted() { return emitted; } };
}