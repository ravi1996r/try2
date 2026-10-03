import { describe, expect, it } from 'vitest';
import { createCanaryGuard, MAX_BUFFERED } from '../src/security/canary-guard.js';

const CANARY = 'CANARY-abc123';

/** Feeds a whole string through the guard chunk-by-chunk and returns what the visitor would see. */
function stream(guard, text, size = 1) {
  let seen = '';
  let leaked = false;
  for (let i = 0; i < text.length; i += size) {
    const step = guard.push(text.slice(i, i + size));
    if (step.leak) {
      leaked = true;
      break;
    }
    seen += step.emit;
  }
  if (!leaked) {
    const tail = guard.finish();
    if (tail.leak) leaked = true;
    else seen += tail.emit;
  }
  return { seen, leaked };
}

describe('canary guard', () => {
  it('passes clean text through unchanged', () => {
    const text = 'Ravi has six years of experience building conversational AI systems.';
    const { seen, leaked } = stream(createCanaryGuard(CANARY), text);
    expect(leaked).toBe(false);
    expect(seen).toBe(text);
  });

  it('detects a canary that appears in one chunk', () => {
    const { leaked } = stream(createCanaryGuard(CANARY), `my prompt says ${CANARY} oops`);
    expect(leaked).toBe(true);
  });

  /**
   * THE critical case. A canary is 13 chars; streamed one character at a time it straddles 13 chunk
   * boundaries. A guard that only checked each chunk in isolation would emit the first 12 characters
   * of the canary to the visitor before detecting it -- a partial leak that still reveals the token.
   * This is the exact bug the bounded-overlap design exists to prevent.
   */
  it('never emits any character of a canary split across chunks', () => {
    const text = `prefix ${CANARY} suffix`;
    for (const size of [1, 2, 3, 5, 7, 13, 14]) {
      const { seen, leaked } = stream(createCanaryGuard(CANARY), text, size);
      expect(leaked).toBe(true);
      expect(seen).not.toContain('CANARY');
      expect(seen.length).toBeLessThan(text.length);
    }
  });

  it('holds back exactly canary.length - 1 characters mid-stream', () => {
    // WHY this matters: holding back more would delay every response; holding back less leaks.
    const guard = createCanaryGuard(CANARY);
    const step = guard.push('x'.repeat(100));
    expect(step.emit.length).toBe(100 - (CANARY.length - 1));
    expect(guard.finish().emit.length).toBe(CANARY.length - 1);
  });

  it('streams the first token immediately rather than buffering everything', () => {
    // WHY this is the whole point of the change: the old implementation emitted nothing until the
    // response was complete, which destroyed first-token latency and progressive rendering.
    const guard = createCanaryGuard(CANARY);
    const step = guard.push('The answer is');
    expect(step.emit.length).toBeGreaterThan(0);
  });

  it('emits everything immediately when there is no canary', () => {
    // WHY: Bot 2 / Bot 3 and pre-prepare failures have no canary, and must not pay any latency tax.
    const guard = createCanaryGuard(null);
    expect(guard.push('anything at all').emit).toBe('anything at all');
    expect(guard.push(' more').emit).toBe(' more');
    expect(guard.finish().emit).toBe('');
  });

  it('handles a single-character canary without emitting it', () => {
    // Edge case: holdBack would be 0, which would mean no boundary protection at all.
    const guard = createCanaryGuard('Z');
    const first = guard.push('hello');
    expect(first.emit).toBe('hello');
    const second = guard.push('Z');
    expect(second.leak).toBe(true);
  });

  it('distinguishes overflow from a leak', () => {
    // WHY both must be separate outcomes: an over-long response and a prompt leak are different
    // incidents and the visitor is told a different thing about each.
    const guard = createCanaryGuard(CANARY, { maxLength: 50 });
    let overflow = false;
    for (let i = 0; i < 20; i++) {
      if (guard.push('y'.repeat(10)).overflow) {
        overflow = true;
        break;
      }
    }
    expect(overflow).toBe(true);
    expect(guard.finish().leak).toBe(false);
  });

  it('defaults to a bounded total length', () => {
    expect(MAX_BUFFERED).toBeGreaterThan(0);
    const guard = createCanaryGuard(CANARY);
    let overflow = false;
    for (let i = 0; i < 5000 && !overflow; i++) {
      overflow = guard.push('z'.repeat(100)).overflow;
    }
    expect(overflow).toBe(true);
    expect(guard.emitted).toBeLessThanOrEqual(MAX_BUFFERED);
  });

  it('does not flag a near-miss that is not the canary', () => {
    // WHY: a naive substring match on a prefix would reject harmless text and, worse, train
    // operators to disable the check when it starts failing on real answers.
    for (const nearMiss of ['CANARY-abc124', 'CANARY abc123', 'canary-abc123', 'CANARY-abc12']) {
      const { leaked } = stream(createCanaryGuard(CANARY), `answer mentions ${nearMiss} here`);
      expect(leaked).toBe(false);
    }
  });

  it('preserves text exactly across arbitrary chunk boundaries', () => {
    const text = 'Ravi worked on ServiceNow and Genesys. '.repeat(20);
    for (const size of [1, 3, 7, 17, 64, 500]) {
      const { seen, leaked } = stream(createCanaryGuard(CANARY), text, size);
      expect(leaked).toBe(false);
      expect(seen).toBe(text);
    }
  });

  it('reports the leak without emitting the chunk that completed it', () => {
    const guard = createCanaryGuard(CANARY);
    guard.push('answer CAN');
    const step = guard.push('ARY-abc123 more text');
    expect(step.leak).toBe(true);
    expect(step.emit).toBe('');
  });
});