/**
 * The backend switch: prove that a configured kind is either honoured or loudly refused.
 *
 * WHY these tests exist: the previous implementation branched only on 'disk' and used memory for
 * everything else. Every test below would have failed against it, which is the point -- a switch
 * that silently ignores its own selector is worse than no switch at all.
 */
import { describe, it, expect } from 'vitest';
import { resolveKeyValueStore, KEY_VALUE_BACKENDS, MANAGED_SERVICE_MAP } from '../src/backends/registry.js';
import { loadConfig } from '../src/config.js';

const baseEnv = { APP_ENV: 'local', USE_LOCAL_FALLBACKS: 'true' };

describe('backend switch: the selector is honoured', () => {
  it('defaults to memory, which needs nothing installed', async () => {
    const config = loadConfig(baseEnv);
    expect(config.cacheBackend).toBe('memory');
    const { store, actual } = await resolveKeyValueStore(config);
    expect(actual).toBe('memory');
    expect(store.backendName).toBe('memory');
  });

  it('builds the disk store when disk is selected', async () => {
    const config = loadConfig({ ...baseEnv, CACHE_BACKEND: 'disk', PORTFOLIO_DATA_DIR: './data' });
    const { store, actual } = await resolveKeyValueStore(config);
    expect(actual).toBe('disk');
    expect(store.backendName).not.toBe('memory');
  });
});

describe('backend switch: no silent fallback', () => {
  it('refuses redis rather than quietly using memory', async () => {
    const config = loadConfig({ ...baseEnv, CACHE_BACKEND: 'redis', REDIS_URL: 'redis://127.0.0.1:6379' });
    // WHY this assertion is the whole point of the suite: the old code returned a working memory store
    // here, so an operator selecting Redis would never learn that Redis was not in use.
    await expect(resolveKeyValueStore(config)).rejects.toThrow(/cannot start/i);
  });

  it('names the remedy, the requirement and a free alternative in the failure', async () => {
    const config = loadConfig({ ...baseEnv, CACHE_BACKEND: 'redis', REDIS_URL: 'redis://127.0.0.1:6379' });
    // WHY assert on missingKeys rather than the message: ConfigError carries its remedy lines there,
    // which is the channel the server already renders for the operator. Asserting on `.message` would
    // pass only if the remedy were inlined into the sentence, which would duplicate it.
    const err = await resolveKeyValueStore(config).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const remedies = err.missingKeys.join('\n');
    // WHY assert on the remedy: a bare "redis unavailable" leaves the operator guessing. The message
    // must name what to do, or the switch is not usable.
    expect(remedies).toMatch(/CACHE_BACKEND=disk/);
    expect(remedies).toMatch(/REDIS_URL/);
    expect(remedies).toMatch(/never falls back silently/i);
  });

  it('surfaces REDIS_URL to the adapter rather than requiring a value config never read', () => {
    // WHY: REDIS_URL was validated as required when CACHE_BACKEND=redis, but was never placed on the
    // config object, so the adapter could not have used it. Declaring a variable is not using it.
    const config = loadConfig({ ...baseEnv, CACHE_BACKEND: 'redis', REDIS_URL: 'redis://host:6379' });
    expect(config.redisUrl).toBe('redis://host:6379');
    expect(config.redisKeyPrefix).toBeTruthy();
  });

  it('honours redis when a client is explicitly injected', async () => {
    const config = loadConfig({ ...baseEnv, CACHE_BACKEND: 'redis', REDIS_URL: 'redis://host:6379' });
    const client = {
      getWithTtl: async () => [null, null],
      set: async () => {}, del: async () => 0, incrBy: async () => 1,
      keys: async () => [], evalDel: async () => 0,
    };
    const { store, actual } = await resolveKeyValueStore(config, { redisClient: client });
    expect(actual).toBe('redis');
    expect(store.backendName).toBe('redis');
  });
});

describe('backend switch: registry metadata stays honest', () => {
  it('every backend states whether it is durable and what it costs', () => {
    // WHY: "FREE" with no qualifier is the kind of claim AGENTS.md rule 3 rejects. Each entry must
    // carry its own cost so a reader never has to guess.
    for (const [kind, b] of Object.entries(KEY_VALUE_BACKENDS)) {
      expect(b.label, `${kind} missing label`).toBeTruthy();
      expect(b.costs, `${kind} missing costs`).toBeTruthy();
      expect(typeof b.durable, `${kind} missing durable`).toBe('boolean');
      expect(typeof b.create, `${kind} missing factory`).toBe('function');
    }
  });

  it('names a local substitute for every managed service', () => {
    // WHY: the premise of this table is that the paid option is optional. A row without a substitute
    // would quietly imply the managed service is required.
    for (const row of MANAGED_SERVICE_MAP) {
      expect(row.service).toBeTruthy();
      expect(row.role, `${row.service} missing role`).toBeTruthy();
      expect(row.localDefault, `${row.service} has no local substitute`).toMatch(/BACKEND=|PROVIDER=/);
    }
  });
});