/**
 * `npm run load` — concurrency harness against the FAKE provider.
 *
 * WHY only the fake: AGENTS.md forbids claiming performance against a service that bills money. The
 * fake reproduces the wire format and streaming behaviour, so this measures THIS system's concurrency
 * honestly -- and the output states plainly that it says nothing about any real provider.
 */
import { percentile, startStack } from './lib/stack.mjs';

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 8);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 24);

/** One chat turn; returns { ok, status, ms }. */
async function turn(sessionId) {
  const t0 = performance.now();
  try {
    const res = await fetch('http://127.0.0.1:18082/v1/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bot: 'bot1', message: 'Summarise Ravi distributed systems experience.', history: [], session_id: sessionId,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    await res.text();
    return { ok: res.ok, status: res.status, ms: performance.now() - t0 };
  } catch (err) {
    return { ok: false, status: 0, ms: performance.now() - t0, error: err.message };
  }
}

let stack;
try {
  stack = await startStack({
    quiet: true,
    extraEnv: {
      // WHY raise the caps: with the documented limits every request past the first few is a 429, so
      // the run would measure the rate limiter instead of the server.
      PORTFOLIO_RATE_LIMIT_PER_IP_PER_MINUTE: '100000',
      PORTFOLIO_RATE_LIMIT_PER_SESSION_PER_MINUTE: '100000',
    },
  });

  console.log(`load: ${REQUESTS} requests at concurrency ${CONCURRENCY} against the FAKE provider\n`);

  // WHY a warm-up round: the first request pays SQLite open, index load and JIT. Counting it would
  // measure cold start, which is a different and separately interesting number.
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => turn(`warmup-${i}`)));

  const results = [];
  let issued = 0;
  const wallStart = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, worker) => {
    while (issued < REQUESTS) {
      issued += 1;
      // WHY a session per worker: the session limiter is separate from the IP one, so one shared
      // session would funnel every request onto a single counter.
      results.push(await turn(`load-${worker}`));
    }
  }));
  const wallMs = performance.now() - wallStart;

  const ok = results.filter((r) => r.ok);
  const latencies = ok.map((r) => r.ms);
  const failures = results.filter((r) => !r.ok);
  const byStatus = failures.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {});

  console.log('| Metric | Value |');
  console.log('| --- | --- |');
  console.log(`| requests | ${results.length} |`);
  console.log(`| succeeded (HTTP 200) | ${ok.length} |`);
  console.log(`| failed | ${failures.length} |`);
  console.log(`| wall clock | ${(wallMs / 1000).toFixed(2)} s |`);
  console.log(`| throughput | ${(results.length / (wallMs / 1000)).toFixed(2)} req/s |`);
  console.log(`| latency p50 | ${percentile(latencies, 50).toFixed(0)} ms |`);
  console.log(`| latency p95 | ${percentile(latencies, 95).toFixed(0)} ms |`);
  console.log(`| latency p99 | ${percentile(latencies, 99).toFixed(0)} ms |`);
  console.log(`| latency max | ${Math.max(0, ...latencies).toFixed(0)} ms |`);
  if (failures.length) {
    console.log('\nNon-200 statuses:');
    for (const [status, n] of Object.entries(byStatus)) console.log(`  ${status}: ${n}`);
  }
  console.log(
    '\nSCOPE: gateway + AI service + retrieval concurrency against a LOCAL FAKE. This says\n'
    + 'nothing about any real provider and must never be quoted as if it did.',
  );

  // WHY the gate is "no errors" and not a latency target: no SLO has been agreed for this project, so
  // inventing a threshold here would manufacture a pass/fail line out of nothing. Correctness is the
  // only defensible gate until a target is actually agreed.
  process.exitCode = failures.length > 0 ? 1 : 0;
} catch (err) {
  console.error(`load FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (stack) await stack.stop();
}