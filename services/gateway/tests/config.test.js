import { loadConfig, startupBanner, isDenylisted, ConfigError } from '../src/config.js';

describe('config: defaults and precedence', () => {
  test('boots with zero credentials on local defaults', () => {
    // WHY: this is E2E-36's precondition. If an empty environment could not produce a working
    // config, the whole "runs locally out of the box" claim would be false.
    const config = loadConfig({});
    expect(config.appEnv).toBe('local');
    expect(config.useLocalFallbacks).toBe(true);
    expect(config.dbBackend).toBe('sqlite');
    expect(config.cacheBackend).toBe('memory');
    expect(config.vectorBackend).toBe('local');
    expect(config.blobBackend).toBe('local');
    expect(config.searchProvider).toBe('ddg');
    expect(config.productionGuardViolations).toEqual([]);
  });

  test('an absent site-model key is not a startup error in local mode', () => {
    // Honesty rule: with no credentials the app must still start, and chat must report
    // "unconfigured" rather than crash.
    const config = loadConfig({ APP_ENV: 'local' });
    expect(config.secrets.OPENROUTER_API_KEY).toBeUndefined();
  });

  test('environment variable overrides the built-in default', () => {
    const config = loadConfig({ GATEWAY_PORT: '9999', DB_BACKEND: 'mongodb', MONGODB_URI: 'mongodb://x' });
    expect(config.port).toBe(9999);
    expect(config.dbBackend).toBe('mongodb');
  });

  test('rejects an out-of-range integer with the key NAME and no value', () => {
    expect(() => loadConfig({ GATEWAY_PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEWAY_PORT: '99999' })).toThrow(/GATEWAY_PORT/);
  });

  test('rejects an invalid enum value naming the allowed set', () => {
    expect(() => loadConfig({ DB_BACKEND: 'postgres' })).toThrow(/DB_BACKEND must be one of/);
  });
});

describe('config: denylist', () => {
  test('recognises every employer-owned prefix', () => {
    for (const name of [
      'SERVICENOW_INSTANCE', 'NEXTTHINK_TOKEN', 'ADF_PIPELINE', 'DIRECTLINE_SECRET',
      'MICROSOFT-APP_ID', 'servicenow_lower',
    ]) {
      expect(isDenylisted(name)).toBe(true);
    }
    expect(isDenylisted('OPENROUTER_API_KEY')).toBe(false);
  });

  test('denylisted variables never reach the config object', () => {
    // WHY: a filter that "ignores but logs" still leaks the name. The drop happens before storage.
    const config = loadConfig({
      SERVICENOW_INSTANCE: 'acme',
      DIRECTLINE_SECRET: 'abc123',
      GATEWAY_PORT: '8082',
    });
    const serialised = JSON.stringify(config);
    expect(serialised).not.toContain('SERVICENOW');
    expect(serialised).not.toContain('DIRECTLINE');
    expect(serialised).not.toContain('acme');
    expect(serialised).not.toContain('abc123');
  });

  test('the startup banner never prints a secret value', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'sk-super-secret-value' });
    const banner = startupBanner(config);
    expect(banner).not.toContain('sk-super-secret-value');
    expect(banner).toContain('llm=openrouter');
  });
});

describe('config: production guard', () => {
  test('production with local backends is flagged, and lists the concerns', () => {
    const config = loadConfig({
      APP_ENV: 'production',
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_MODEL: 'm',
      DB_BACKEND: 'sqlite',
      VECTOR_BACKEND: 'local',
      CACHE_BACKEND: 'memory',
      BLOB_BACKEND: 'local',
      EMBEDDING_PROVIDER: 'local',
      PORTFOLIO_SEARCH_PROVIDER: 'brave',
      PORTFOLIO_SEARCH_API_KEY: 'k',
    });
    expect(config.productionGuardViolations).toContain('db');
    expect(config.productionGuardViolations).toContain('vector');
    expect(config.productionGuardViolations).toContain('cache');
    expect(config.productionGuardViolations).toContain('blob');
    expect(config.productionGuardViolations).toContain('embeddings');
    // brave is an official provider, so search must NOT be flagged.
    expect(config.productionGuardViolations).not.toContain('search');
  });

  test('the explicit override clears the violations', () => {
    const config = loadConfig({
      APP_ENV: 'production',
      PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION: 'true',
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_MODEL: 'm',
      PORTFOLIO_SEARCH_PROVIDER: 'brave',
      PORTFOLIO_SEARCH_API_KEY: 'k',
    });
    expect(config.productionGuardViolations).toEqual([]);
  });
});

describe('config: fail-fast naming only the missing key', () => {
  test('production + a selected backend with no key fails naming the KEY, never a value', () => {
    let caught;
    try {
      loadConfig({
        APP_ENV: 'production',
        LLM_PROVIDER: 'azure_openai',
        DB_BACKEND: 'mongodb',
        CACHE_BACKEND: 'redis',
        VECTOR_BACKEND: 'azure_search',
        BLOB_BACKEND: 'azure_blob',
        EMBEDDING_PROVIDER: 'local',
        PORTFOLIO_SEARCH_PROVIDER: 'none',
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught.missingKeys).toContain('AZURE_OPENAI_ENDPOINT');
    expect(caught.missingKeys).toContain('MONGODB_URI');
    expect(caught.missingKeys).toContain('REDIS_URL');
    expect(caught.missingKeys).toContain('AZURE_SEARCH_ENDPOINT');
    expect(caught.missingKeys).toContain('AZURE_BLOB_CONNECTION_STRING');
  });

  test('keys for UNSELECTED backends are not required', () => {
    // WHY: local boot must not demand Azure/Mongo/Redis configuration.
    const config = loadConfig({ APP_ENV: 'production', LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: 'm', PORTFOLIO_SEARCH_PROVIDER: 'brave', PORTFOLIO_SEARCH_API_KEY: 'k' });
    expect(config.dbBackend).toBe('sqlite');
  });
});