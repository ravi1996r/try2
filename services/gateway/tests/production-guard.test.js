import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

/** Starts a server and waits for it to actually be listening. */
async function boot(env) {
  // WHY a store is injected here: this suite is about the PRODUCTION GUARD, not about Redis. But a
  // fully cloud-backed config legitimately selects CACHE_BACKEND=redis, and the registry now honours
  // that request instead of quietly downgrading it to memory. Rather than weaken the fixture by
  // weakening the switch, the store is supplied explicitly -- the config still says redis, and the
  // guard is exercised against exactly the configuration it will meet in production.
  const { createMemoryKeyValueStore } = await import('../src/backends/keyvalue.js');
  const { server } = await startServer(env, { store: createMemoryKeyValueStore() });
  if (!server.listening) {
    await new Promise((r) => server.once('listening', r));
  }
  return server;
}

/** Closes a server, tolerating one that never opened a port. */
async function shutdown(server) {
  if (!server) return;
  await new Promise((r) => server.close(r));
}

/**
 * WHY these tests exist: the production guard computed violations correctly, and startServer() then
 * PRINTED them and listened anyway. A production deployment on local engines or a fake provider would
 * boot, log a warning nobody reads, and serve real traffic -- exactly what the guard exists to stop.
 *
 * Every test asserts on startServer() REJECTING, not on config reporting violations, because
 * reporting is what already worked. The bug lived in the gap between detection and refusal.
 */
/**
 * A production environment whose only problem is running on local backends.
 *
 * WHY this lives at module scope rather than inside describe(): cleanProdEnv() calls it, and a
 * function declared inside the describe callback is not in scope at module level.
 */
function prodEnv(overrides = {}) {
  return {
    APP_ENV: 'production',
    USE_LOCAL_FALLBACKS: 'false',
    PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION: 'false',
    SITE_ORIGIN: 'https://portfolio.example',
    PORTFOLIO_INTERNAL_SERVICE_AUTH: 'x'.repeat(32),
    // WHY a real port rather than 0: the config validator requires 1..65535, and 0 -- though the OS
    // reads it as "any free port" -- is correctly rejected as a nonsensical configured port.
    GATEWAY_PORT: '39217',
    OPENROUTER_API_KEY: 'or-test-key-000000000000',
    OPENROUTER_MODEL: 'test/model',
    ...overrides,
  };
}

/**
 * A production configuration with NO local concerns.
 *
 * WHY it must be exhaustive: the guard checks seven concerns (db, cache, vector, blob, llm,
 * embeddings, search) plus fake-providers. Leaving any one at its local default makes this config
 * correctly REFUSE -- which is the guard doing its job, and is why the blob and search entries were
 * added only after the first version of this test failed.
 */
function cleanProdEnv(overrides = {}) {
  return prodEnv({
    DB_BACKEND: 'mongodb',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/portfolio',
    CACHE_BACKEND: 'redis',
    REDIS_URL: 'redis://127.0.0.1:6379',
    VECTOR_BACKEND: 'azure_search',
    AZURE_SEARCH_ENDPOINT: 'https://example.search.windows.net',
    AZURE_SEARCH_API_KEY: 'k'.repeat(32),
    EMBEDDING_PROVIDER: 'azure_openai',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    AZURE_OPENAI_API_KEY: 'k'.repeat(32),
    AZURE_OPENAI_CHAT_DEPLOYMENT: 'gpt',
    BLOB_BACKEND: 'azure_blob',
    AZURE_BLOB_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=' + 'k'.repeat(64),
    // WHY the PORTFOLIO_ prefix: the gateway reads PORTFOLIO_SEARCH_PROVIDER, not SEARCH_PROVIDER. The
    // first version of this fixture used the unprefixed name, and the guard correctly still reported
    // `search` -- which is the guard working, not a guard bug.
    PORTFOLIO_SEARCH_PROVIDER: 'brave',
    PORTFOLIO_SEARCH_API_KEY: 'k'.repeat(32),
    ...overrides,
  });
}

describe('production guard: startup must REFUSE, not merely warn', () => {
  it('refuses to start when production resolves to a local engine', async () => {
    // DB_BACKEND defaults to local, so this is the realistic "forgot to configure production" case.
    const env = prodEnv();
    const cfg = loadConfig(env);
    // Precondition: the guard really did detect something. If this fails, the test is vacuous.
    expect(cfg.productionGuardViolations.length).toBeGreaterThan(0);

    await expect(startServer(env)).rejects.toThrow(/Refusing to start in production/);
  });

  it('the refusal names every violation', async () => {
    const env = prodEnv();
    const cfg = loadConfig(env);
    let message = '';
    try {
      await startServer(env);
    } catch (err) {
      message = err.message;
    }
    for (const violation of cfg.productionGuardViolations) {
      expect(message).toContain(violation);
    }
  });

  it('the refusal mentions the explicit override, so the operator has a next step', async () => {
    // WHY: a refusal with no remedy trains operators to disable the guard. The message must say
    // exactly which switch to set, and that it is only for deliberate demos.
    const env = prodEnv();
    let message = '';
    try {
      await startServer(env);
    } catch (err) {
      message = err.message;
    }
    expect(message).toContain('PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION');
    expect(message).toMatch(/demo/i);
  });

  it('the refusal never echoes a secret value', async () => {
    // WHY: the message is printed to stdout and captured by supervisors and CI. It must contain
    // violation LABELS only.
    const secret = 'S3cretValueThatMustNeverBePrinted123456';
    const env = prodEnv({ PORTFOLIO_INTERNAL_SERVICE_AUTH: secret });
    let message = '';
    try {
      await startServer(env);
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toContain(secret);
  });

  it('starts when the override is explicitly set', async () => {
    const env = prodEnv({ PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION: 'true', GATEWAY_PORT: '39219' });
    const server = await boot(env);
    try {
      expect(server.listening).toBe(true);
    } finally {
      await shutdown(server);
    }
  });

  it('does not refuse in local mode', async () => {
    // WHY: refusing here would make the whole local-first premise unrunnable. The guard is a
    // PRODUCTION guard and must be inert locally, including with the default local backends.
    const env = {
      APP_ENV: 'local',
      USE_LOCAL_FALLBACKS: 'true',
      SITE_ORIGIN: 'http://localhost:5173',
      GATEWAY_PORT: '39220',
    };
    const server = await boot(env);
    try {
      expect(server.listening).toBe(true);
    } finally {
      await shutdown(server);
    }
  });

  it('reports no violations for a fully cloud-backed production config', async () => {
    // WHY the converse case: a guard that always fires is as useless as one that never fires.
    expect(loadConfig(cleanProdEnv()).productionGuardViolations).toEqual([]);
  });

  it('a fully cloud-backed production config starts without refusing', async () => {
    const server = await boot(cleanProdEnv({ GATEWAY_PORT: '39221' }));
    try {
      expect(server.listening).toBe(true);
    } finally {
      await shutdown(server);
    }
  });

  it('refuses when only the fake providers are enabled', async () => {
    // WHY its own test: fake providers answer every request with a tagged fake response. A
    // production deployment pointed at them would look healthy while returning nothing real. This
    // config is otherwise completely clean, so the ONLY violation is fake-providers -- which proves
    // that concern is checked independently of the backend selectors.
    const env = cleanProdEnv({ PORTFOLIO_FAKE_PROVIDERS: 'true' });
    expect(loadConfig(env).productionGuardViolations).toEqual(['fake-providers']);
    // WHY a store is injected even though this test expects a refusal: createApp() constructs the
    // store promise before the guard runs, and a fully cloud-backed config selects Redis, which has
    // no client in CI. Without a store that promise rejects and, because the guard throws before
    // anyone awaits it, Node reports an unhandled rejection and fails the whole file. The guard
    // behaviour under test is unchanged.
    const { createMemoryKeyValueStore } = await import('../src/backends/keyvalue.js');
    await expect(startServer(env, { store: createMemoryKeyValueStore() })).rejects.toThrow(/fake-providers/);
  });
});