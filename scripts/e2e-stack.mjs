/**
 * Long-running stack for the Playwright E2E suite: fake providers + AI service + gateway on the
 * DOCUMENTED dev ports, then blocks until killed.
 *
 * WHY this is separate from scripts/dev.mjs: `npm run dev` refuses to start when ports are busy,
 * which is right for a human and wrong for a harness that must fail loudly rather than silently
 * attach to whatever happens to be running. The boot logic itself is shared via scripts/lib/stack.mjs,
 * so there is still one implementation of "start the three services".
 *
 * WHY block instead of exiting: Playwright's `webServer` supervises this process for the whole run
 * and kills it afterwards. If it exited once healthy, Playwright would report the server as stopped.
 */
import { startStack } from './lib/stack.mjs';

const stack = await startStack({
  quiet: true,
  // WHY the documented ports: the built page calls `/api/...` on its own origin, and the CSP
  // `connect-src` origin is http://localhost:8082. Running the E2E gateway on the 180xx harness port
  // would make every chat request a 404 that a streaming assertion could misread as "an answer".
  ports: { ai: 8080, gateway: 8082, fakeOpenai: 8090 },
});

console.log(`[e2e-stack] gateway healthy at ${stack.gatewayUrl}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await stack.stop();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

// WHY a self-rescheduling unref'd timer rather than setInterval: an interval would keep the event
// loop busy and show up as measurable CPU while the tests ran, which `perf:local` would then report.
const keepAlive = () => { setTimeout(keepAlive, 60_000).unref(); };
keepAlive();