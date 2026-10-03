/**
 * Port inspection for `npm run dev`, factored out so it can be unit tested without booting
 * anything. Importing this module must never start a process.
 */
import { createServer } from 'node:net';

/**
 * WHY these ports: AGENTS.md documents web :5173, gateway :8082, AI service :8080 and fake
 * providers :8090-:8093. FAKE_PROVIDERS_SEARCH_PORT (:8094) is included because .env.example
 * declares it and the fake server binds it.
 */
export const REQUIRED_PORTS = Object.freeze([
  { port: 5173, label: 'web (Vite)' },
  { port: 8080, label: 'AI service (FastAPI)' },
  { port: 8082, label: 'gateway (Express)' },
  { port: 8090, label: 'fake provider (OpenAI-compatible)' },
  { port: 8091, label: 'fake provider (Ollama)' },
  { port: 8092, label: 'fake provider (Anthropic)' },
  { port: 8093, label: 'fake provider (Gemini)' },
  { port: 8094, label: 'fake search provider' },
]);

/**
 * Resolves true when nothing is listening on the port.
 *
 * WHY probe by binding rather than by connecting: connecting succeeds against a bound socket, which
 * is the opposite of what we want to know. We must ask "can I take this port?", and the only
 * truthful way to ask is to try to take it.
 *
 * @returns {Promise<boolean>}
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    // WHY once: a failed bind fires 'error' once and would otherwise be followed by a spurious
    // unhandled 'close' resolve, which could report the port as free after it proved it was not.
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Checks every required port concurrently.
 *
 * WHY concurrent: eight sequential binds cost eight round-trips for a check that runs on every
 * `npm run dev`. There is no ordering dependency between them.
 *
 * @returns {Promise<Array<{port:number,label:string,free:boolean}>>}
 */
export async function checkPorts(required = REQUIRED_PORTS) {
  return Promise.all(required.map(async (entry) => ({
    ...entry,
    free: await isPortFree(entry.port),
  })));
}

/**
 * Formats the busy-port report.
 *
 * WHY name the process to kill: "port 8082 is in use" leaves the reader guessing. `netstat -ano`
 * on Windows and `lsof -i :8082` elsewhere are the standard next steps, and saying so turns a
 * blocker into a one-line fix.
 */
export function formatBusyPortReport(busy) {
  const lines = busy.map((b) => `  :${b.port}  ${b.label}`);
  const hint = process.platform === 'win32'
    ? 'Find the owner with: netstat -ano | findstr :<port>'
    : 'Find the owner with: lsof -i :<port>';
  return [
    `Refusing to start: ${busy.length} required port(s) already in use.`,
    '',
    ...lines,
    '',
    `Stop the process holding the port, or free it, then run \`npm run dev\` again.`,
    hint,
  ].join('\n');
}