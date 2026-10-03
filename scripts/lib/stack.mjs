/**
 * Boots the real cross-process stack: AI service (Python) -> fake providers -> gateway (Node).
 *
 * WHY this is not done with mocks: the thing being verified IS the wiring. The gateway's
 * `prepareTurn` does an HTTP call to the AI service, which retrieves from a SQLite index and calls a
 * provider. A mocked hop proves the mock is shaped right, which is not the question. This module
 * exists so the integration tests do not have to reimplement process management.
 *
 * WHY non-default ports (18080/18082/18090): the documented dev ports must stay free, and a test
 * that collides with a running `npm run dev` would fail intermittently for unrelated reasons.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PORTS = Object.freeze({
  ai: 18080,
  gateway: 18082,
  fakeOpenai: 18090,
});

/** Resolves the repo Python interpreter, preferring the documented venv. */
function pythonBin() {
  const venv = process.platform === 'win32'
    ? join(ROOT, '.venv', 'Scripts', 'python.exe')
    : join(ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
}

/** Polls a URL until it answers or the deadline passes. */
async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`service at ${url} never became healthy in ${timeoutMs}ms (last: ${lastError})`);
}
/**
 * Starts the whole stack and returns handles plus a stop function.
 *
 * WHY a throwaway data directory: the AI service builds its retrieval index under
 * PORTFOLIO_DATA_DIR. Sharing the developer's real ./data would mean an integration run could mutate
 * real state, and two concurrent runs would corrupt each other.
 */
export async function startStack(opts = {}) {
  const { extraEnv = {}, freshData = true, quiet = false, ports: portOverride } = opts;
  // WHY a port override: the integration suite uses 180xx so it never collides with a running
  // `npm run dev`. The E2E suite needs the DOCUMENTED ports (8080/8082) because the page's `/api`
  // paths and the CSP origin assume them. One implementation, two port profiles.
  const ports = { ...PORTS, ...(portOverride ?? {}) };
  // WHY a dummy key: the gateway refuses to serve the site path without a key, and this run talks
  // only to the FAKE provider on loopback. This is a placeholder, not a credential.
  const dataDir = freshData ? mkdtempSync(join(tmpdir(), 'portfolio-run-')) : undefined;
  const base = {
    APP_ENV: 'local',
    USE_LOCAL_FALLBACKS: 'true',
    PORTFOLIO_LOG_LEVEL: 'warn',
    PORTFOLIO_TELEMETRY_ENABLED: 'false',
    PORTFOLIO_PROFILE_PATH: join(ROOT, 'content', 'profile.json'),
    ...(dataDir ? { PORTFOLIO_DATA_DIR: dataDir } : {}),
    ...extraEnv,
  };

  const children = [];
  const spawnChild = (name, cmd, args, env, cwd = ROOT) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...base, ...env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (err) => console.error(`[stack:${name}] spawn failed: ${err.message}`));
    // WHY keep stderr attached: if a service refuses to boot, the failure message must include WHY,
    // otherwise the run is unactionable. Harnesses pass quiet:true because a burst of warnings would
    // bury their results table.
    if (!quiet) {
      child.stderr.on('data', (c) => {
        const s = c.toString().trim();
        if (s) console.error(`[stack:${name}] ${s}`);
      });
    }
    children.push({ name, child });
    return child;
  };

  try {
    spawnChild('fake', process.execPath, [join(ROOT, 'ops', 'fake-providers', 'server.js')], {
      FAKE_PROVIDERS: 'true',
      // WHY zero the offset: the fake provider adds FAKE_PORT_OFFSET (derived from VITEST_WORKER_ID)
      // to every port so parallel Vitest suites do not collide. That is correct for unit tests but
      // wrong here: the gateway below is configured with ABSOLUTE ports, so any offset silently
      // points the gateway at nothing. It surfaced as EADDRINUSE on 18100 = 18090 + 10.
      FAKE_PORT_OFFSET: '0',
      FAKE_PROVIDERS_PORT: String(ports.fakeOpenai),
      FAKE_PROVIDERS_OLLAMA_PORT: String(ports.fakeOpenai + 1),
      FAKE_PROVIDERS_ANTHROPIC_PORT: String(ports.fakeOpenai + 2),
      FAKE_PROVIDERS_GEMINI_PORT: String(ports.fakeOpenai + 3),
      FAKE_PROVIDERS_SEARCH_PORT: String(ports.fakeOpenai + 4),
    }, join(ROOT, 'ops', 'fake-providers'));
    await waitForHealth(`http://127.0.0.1:${ports.fakeOpenai}/v1/models`);

    spawnChild('ai', pythonBin(), ['-m', 'services.ai.app.main'], {
      PYTHONUNBUFFERED: '1',
      AI_SERVICE_HOST: '127.0.0.1',
      AI_SERVICE_PORT: String(ports.ai),
    });
    await waitForHealth(`http://127.0.0.1:${ports.ai}/healthz`);

    spawnChild('gateway', process.execPath, [join(ROOT, 'services/gateway/src/server.js')], {
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(ports.gateway),
      AI_SERVICE_BASE_URL: `http://127.0.0.1:${ports.ai}`,
      LLM_PROVIDER: 'openai_compatible',
      LLM_BASE_URL: `http://127.0.0.1:${ports.fakeOpenai}/v1`,
      LLM_MODEL: 'fake-model',
      LLM_API_KEY: 'integration-placeholder-not-a-secret',
    });
    await waitForHealth(`http://127.0.0.1:${ports.gateway}/healthz`);
  } catch (err) {
    await stopStack(children, dataDir);
    throw err;
  }

  return {
    ports,
    gatewayUrl: `http://127.0.0.1:${ports.gateway}`,
    stop: () => stopStack(children, dataDir),
  };
}

/** Nearest-rank percentile.
 *
 * WHY nearest-rank and not interpolation: with 24 samples, interpolated percentiles imply a precision
 * the data does not have. Nearest-rank always reports a value that was actually observed, which is
 * what an honest small-N benchmark can claim.
 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
async function stopStack(children, dataDir) {
  for (const { child } of children) {
    try {
      if (child.pid) child.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  await Promise.all(children.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    // WHY the hard kill as a backstop: a child ignoring SIGTERM would keep its port bound and make
    // the NEXT run fail for a reason that looks unrelated.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve();
    }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}