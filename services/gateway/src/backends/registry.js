/**
 * The backend switch: ONE place that maps a configured backend kind to a real implementation.
 *
 * WHY this file exists: `DB_BACKEND` / `CACHE_BACKEND` / `VECTOR_BACKEND` / `BLOB_BACKEND` were
 * validated by config.js and then *reported* by /healthz -- but nothing actually selected an
 * implementation from them. Setting CACHE_BACKEND=redis produced a gateway that answered
 * `"cache": "redis"` on its health endpoint while silently running the in-memory store. That is the
 * worst failure mode for an operator: a false claim from the system meant to be trusted, in the one
 * endpoint whose whole job is to tell the truth about what is running.
 *
 * THE CONTRACT, and every caller depends on it:
 *   - The requested kind is either honoured, or startup FAILS with a named reason.
 *   - There is no fallback. A fallback here would be invisible, and it would silently reset
 *     rate-limit and budget state on restart -- exactly the class of bug AGENTS.md rule 5 forbids.
 *   - `/healthz` reports `actual`, what the resolver really built -- never `configured`, which is
 *     only what was requested.
 */
import { createMemoryKeyValueStore, createDiskKeyValueStore, createRedisKeyValueStore } from './keyvalue.js';
import { ConfigError } from '../config.js';

/**
 * Every key/value backend this project can actually run, and what it costs.
 *
 * WHY `costs` is data rather than prose: the whole premise is that a visitor runs this with zero
 * credentials. Recording the substitute next to the paid option turns the switch into a decision
 * rather than a research task.
 */
export const KEY_VALUE_BACKENDS = Object.freeze({
  memory: {
    label: 'In-memory',
    requires: [],
    costs: 'FREE - nothing to install, nothing to run',
    durable: false,
    create: () => createMemoryKeyValueStore(),
  },
  disk: {
    label: 'SQLite file on disk',
    requires: [],
    // WHY this is the default free alternative to Redis: rate limits and the daily budget are small,
    // bounded, and must survive a restart. A file gives durability with no server and no port.
    costs: 'FREE - one file under data/, git-ignored',
    durable: true,
    create: ({ dataDir }) => createDiskKeyValueStore({ dir: `${dataDir}/cache` }),
  },
  redis: {
    label: 'Redis',
    // WHY the driver is named: a real deployment needs a client, and "redis is not available" leaves
    // the operator guessing which package to install.
    requires: ['REDIS_URL', 'npm:redis'],
    costs: 'Self-hosted is free; managed plans are paid',
    durable: true,
    // WHY an injected client: the conformance suite runs the SAME assertions against all three
    // stores, and a live Redis only exists in a compose profile. Requiring the caller to pass the
    // client keeps this module free of a hard driver dependency.
    create: ({ redisClient, redisUrl, keyPrefix }) => createRedisKeyValueStore({
      url: redisUrl, keyPrefix, client: redisClient,
    }),
  },
});

/**
 * Builds the key/value store the gateway will actually use.
 *
 * @param {object} config   the loaded config.
 * @param {object} [inject] `{ store, redisClient }` for tests and composition.
 * @returns {Promise<{store: object, actual: string}>}
 * @throws {ConfigError} when the requested backend cannot run. NEVER falls back.
 */
export async function resolveKeyValueStore(config, inject = {}) {
  if (inject.store) return { store: inject.store, actual: 'injected' };

  const kind = config.cacheBackend;
  const backend = KEY_VALUE_BACKENDS[kind];
  if (!backend) {
    // Unreachable through config.js's oneOf(), but a registry that trusts its input will eventually
    // be handed something that is not.
    throw new ConfigError(
      `CACHE_BACKEND "${kind}" is not a known backend`,
      [`known: ${Object.keys(KEY_VALUE_BACKENDS).join(', ')}`],
    );
  }

  try {
    const store = await backend.create({
      dataDir: config.dataDir,
      redisUrl: config.redisUrl,
      redisClient: inject.redisClient,
      keyPrefix: config.redisKeyPrefix,
    });
    return { store, actual: kind };
  } catch (err) {
    // WHY rethrow with a remedy rather than the raw message: "requires an injected client" is
    // accurate but leaves the operator guessing. This names what to do instead.
    throw new ConfigError(
      `CACHE_BACKEND="${kind}" is selected but cannot start: ${err.message}`,
      [
        `requires: ${backend.requires.length ? backend.requires.join(', ') : 'nothing'}`,
        `free alternative: CACHE_BACKEND=disk (${backend.costs})`,
        'This project never falls back silently; fix the configuration or choose another backend.',
      ],
    );
  }
}

/**
 * What each managed service replaces, and the local setting that substitutes for it.
 *
 * WHY this is code and not only documentation: a drift test asserts this table still matches
 * .env.example, so adding a cloud variable without documenting its substitute fails the gate.
 */
export const MANAGED_SERVICE_MAP = Object.freeze([
  {
    service: 'MongoDB',
    role: 'document / session store',
    localDefault: 'DB_BACKEND=sqlite',
    note: 'SQLite covers this workload entirely at portfolio scale. Mongo earns its keep only if you '
      + 'already run it and want one operational story across several apps.',
  },
  {
    service: 'Redis',
    role: 'rate limits + daily budget counter',
    localDefault: 'CACHE_BACKEND=disk',
    note: 'Both are tiny, bounded and must survive a restart, so a file suffices. Redis earns its '
      + 'keep when several instances must share one counter.',
  },
  {
    service: 'Azure AI Search',
    role: 'vector retrieval',
    localDefault: 'VECTOR_BACKEND=local (hashed n-gram, Experimental)',
    note: 'The local embedder is weaker than a neural encoder; BM25 carries exact-term recall. Use '
      + 'Azure when answer quality outranks the zero-dependency guarantee.',
  },
  {
    service: 'Azure Blob Storage',
    role: 'Drop-Zone uploads',
    localDefault: 'BLOB_BACKEND=local (data/blob)',
    note: 'Uploads are per-session and TTL-deleted, so a local directory keeps visitor documents off '
      + 'a third party.',
  },
  {
    service: 'Azure OpenAI',
    role: 'site model / embeddings',
    localDefault: 'LLM_PROVIDER=openai_compatible pointed at a local Ollama',
    note: 'Only needed if your Azure deployment already covers inference; any OpenAI-compatible '
      + 'endpoint works, including a free local one.',
  },
]);