/**
 * KeyValueStore: the ONLY way the gateway touches cache / rate-limit / budget state.
 *
 * WHY an interface: sessions, rate limits, the daily budget breaker and Drop-Zone state all need
 * TTL + atomic counters, and business logic must not know whether that is an in-process Map (local)
 * or Redis (production). A single `increment` primitive is the whole reason this abstraction exists:
 * a read-modify-write counter is a race, and a race in a rate limiter is a hole.
 *
 * ALTERNATIVES considered:
 *  - Read the counter, add one, write it back (rejected: two concurrent requests both read 19, both
 *    write 20, and request 21 is admitted. Node is single-threaded, but async handlers interleave at
 *    every await, which is exactly where the race lands.)
 *  - Skip the cache in local mode (rejected: local behaviour would then not match production, and
 *    the brief requires identical limits in both).
 *
 * TRADE-OFF: the memory implementation is single-process. Behind two gateway instances the rate
 * limit becomes per-instance. That is documented as a known limit rather than hidden; production
 * uses Redis, where INCR is atomic across processes.
 */
import { createRequire } from 'node:module';

/**
 * @typedef {object} KVEntry
 * @property {string} key
 * @property {*} value
 * @property {number|null} expiresAt epoch ms, or null when it never expires
 */

/**
 * @typedef {object} KeyValueStore
 * @property {(key: string) => Promise<KVEntry|null>} get
 * @property {(key: string, value: *, opts?: {ttlSeconds?: number}) => Promise<void>} set
 * @property {(key: string) => Promise<boolean>} delete
 * @property {(prefix: string) => Promise<number>} deleteByPrefix
 * @property {(key: string, ttlSeconds: number, amount?: number) => Promise<number>} increment
 * @property {(key: string, value: *, ttlSeconds: number) => Promise<boolean>} setIfAbsent
 * @property {() => Promise<number>} size
 * @property {() => Promise<void>} clear
 * @property {string} backendName
 */

const nowMs = () => Date.now();

/** @returns {KeyValueStore} */
export function createMemoryKeyValueStore({ clock = nowMs } = {}) {
  /** @type {Map<string, KVEntry>} */
  const store = new Map();

  /** Drop expired entries on read, so callers never observe a stale TTL window. */
  const live = (key) => {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= clock()) {
      store.delete(key);
      return null;
    }
    return e;
  };

  return {
    backendName: 'memory',

    async get(key) {
      return live(key) ?? null;
    },

    async set(key, value, { ttlSeconds } = {}) {
      const expiresAt = ttlSeconds && ttlSeconds > 0 ? clock() + ttlSeconds * 1000 : null;
      store.set(key, { key, value, expiresAt });
    },

    async delete(key) {
      return store.delete(key);
    },

    async deleteByPrefix(prefix) {
      let n = 0;
      for (const key of [...store.keys()]) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          n += 1;
        }
      }
      return n;
    },

    /**
     * WHY this is atomic: the read, the add and the TTL decision happen with NO await between
     * them. Node cannot interleave two callers inside this synchronous block, so two concurrent
     * `increment` calls necessarily produce two distinct increments. Adding an `await` anywhere in
     * here would reintroduce the race this method exists to prevent.
     */
    async increment(key, ttlSeconds, amount = 1) {
      const existing = live(key);
      if (existing) {
        const next = Number(existing.value ?? 0) + amount;
        // WHY the TTL is NOT refreshed on increment: a sliding window can be kept alive forever by
        // a determined caller. Rate-limit windows are fixed windows; TTL is set on first write.
        existing.value = next;
        return next;
      }
      const expiresAt = ttlSeconds && ttlSeconds > 0 ? clock() + ttlSeconds * 1000 : null;
      store.set(key, { key, value: amount, expiresAt });
      return amount;
    },

    async setIfAbsent(key, value, ttlSeconds) {
      if (live(key)) return false;
      const expiresAt = ttlSeconds && ttlSeconds > 0 ? clock() + ttlSeconds * 1000 : null;
      store.set(key, { key, value, expiresAt });
      return true;
    },

    async size() {
      // WHY sweep expired keys first: `size` is used by tests and diagnostics, and a store that
      // reports entries it would refuse to return is misleading.
      for (const key of [...store.keys()]) live(key);
      return store.size;
    },

    // WHY these two exist as part of the interface: the disk backend is a memory store with a
    // write-through file, so persisting needs to enumerate live entries. They are read-only.
    async keys() {
      for (const key of [...store.keys()]) live(key);
      return [...store.keys()];
    },

    /** Synchronous peek, used only by the disk backend's write-through serialiser. */
    peek(key) {
      const e = live(key);
      return e ? { value: e.value, expiresAt: e.expiresAt } : null;
    },

    async clear() {
      store.clear();
    },
  };
}

/**
 * Disk-backed variant, persisted as one JSON file.
 *
 * WHY it exists: `CACHE_BACKEND=disk` lets a restart preserve rate-limit/budget state during
 * development without requiring Redis, and it is the local stand-in used to exercise the Redis
 * contract. It is NOT a concurrency-safe store and does not claim to be (see the honest-limits
 * table in docs/16-local-first-backends.md).
 *
 * ALTERNATIVES: SQLite for the disk cache (better concurrency, but pulls a native dependency and a
 * schema for what is a flat keyspace here).
 * WHY NOT: the point of the disk backend is zero-dependency local development.
 *
 * @param {{dir: string, clock?: () => number}} opts
 * @returns {Promise<KeyValueStore>} async because hydrating from disk is awaited before use
 */
export async function createDiskKeyValueStore({ dir, clock = nowMs }) {
  // WHY `createRequire`: this file is ESM, and a top-level `import 'node:fs'` would make the
  // memory-only path pay for an fs import it never uses.
  const require = createRequire(import.meta.url);
  const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
  const { join } = require('node:path');

  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'kv.json');

  let entries = {};
  if (existsSync(file)) {
    try {
      entries = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // WHY a corrupt cache is not fatal: the cache is explicitly never the source of truth.
      // Failing startup because a cache file is unreadable would be a self-inflicted outage.
      entries = {};
    }
  }

  const inner = createMemoryKeyValueStore({ clock });

  // WHY hydrate the in-memory map from disk: the memory store owns TTL semantics and expiry, so the
  // disk store must start as a memory store pre-loaded with the persisted entries. Without this,
  // a second instance would start empty and silently "lose" every key the first instance wrote —
  // the exact bug this line fixes.
  await Promise.all(
    Object.entries(entries).map(async ([key, entry]) => {
      const ttlSeconds = entry.expiresAt
        ? Math.max(0, (entry.expiresAt - clock()) / 1000)
        : 0;
      // An entry that already expired while the process was down is skipped rather than revived.
      if (entry.expiresAt && entry.expiresAt <= clock()) return;
      await inner.set(key, entry.value, { ttlSeconds });
    }),
  );

  const flush = () => {
    // WHY re-serialise from the live store, not from the stale `entries` map: `entries` is only
    // the seed. Serialising it would resurrect keys that have since expired or been deleted.
    const live = {};
    return inner.keys().then((keys) => {
      for (const key of keys) {
        const e = inner.peek(key);
        if (e) live[key] = e;
      }
      writeFileSync(file, JSON.stringify(live), 'utf8');
    });
  };

  // WHY persist on write rather than on an interval: rate-limit correctness must survive an
  // abrupt shutdown, and the write is already off the hot path behind an await boundary.
  const persist = async (result) => { await flush(); return result; };

  return {
    ...inner,
    backendName: 'disk',
    async set(key, value, opts) {
      await inner.set(key, value, opts);
      return persist();
    },
    async delete(key) {
      const r = await inner.delete(key);
      return persist(r);
    },
    async deleteByPrefix(prefix) {
      const n = await inner.deleteByPrefix(prefix);
      return persist(n);
    },
    async increment(key, ttlSeconds, amount) {
      const n = await inner.increment(key, ttlSeconds, amount);
      return persist(n);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      const r = await inner.setIfAbsent(key, value, ttlSeconds);
      return persist(r);
    },
    async clear() {
      await inner.clear();
      rmSync(file, { force: true });
    },
    // Exposed for tests: the on-disk shape is part of the disk backend's contract.
    _snapshot: () => JSON.parse(JSON.stringify(entries)),
    _entries: entries,
  };
}

/**
 * Redis-backed implementation.
 *
 * STATUS: Partially Implemented. The contract and the atomicity argument are settled and tested
 * against the memory store, but the wire calls are only exercised in `test:live` against a real
 * Redis, never in the default zero-credential `verify`. It is therefore NOT claimed as a
 * production-ready adapter. See docs/16-local-first-backends.md and the README feature table.
 *
 * WHY it is not simply "the same Map with a network call": Redis INCR is atomic across processes,
 * which is the entire reason the production rate limiter is correct behind multiple instances and
 * the local one is not. That difference is documented rather than papered over.
 *
 * @param {{url: string, keyPrefix: string, client?: object}} opts
 * @returns {KeyValueStore}
 */
export function createRedisKeyValueStore({ url, keyPrefix = 'portfolio:local', client }) {
  if (!url) throw new Error('createRedisKeyValueStore requires a url');
  // WHY injectable client: the conformance suite runs the same assertions against the memory,
  // disk and Redis stores, and a real Redis is only available in the compose test profile.
  const redis = client ?? null;
  if (!redis) {
    throw new Error(
      'Redis adapter requires an injected client; it is only exercised in the compose test profile',
    );
  }
  const k = (key) => `${keyPrefix}:${key}`;

  return {
    backendName: 'redis',
    async get(key) {
      const [value, expiresAt] = await redis.getWithTtl(k(key));
      if (value === null) return null;
      return { key, value, expiresAt };
    },
    async set(key, value, { ttlSeconds } = {}) {
      await redis.set(k(key), value, ttlSeconds ?? 0);
    },
    async delete(key) {
      return (await redis.del(k(key))) > 0;
    },
    async deleteByPrefix(prefix) {
      return redis.delByPrefix(`${keyPrefix}:${prefix}`);
    },
    // WHY INCR is the whole point: it is atomic server-side, unlike read-modify-write anywhere else.
    async increment(key, ttlSeconds, amount = 1) {
      return redis.incrWithTtl(k(key), ttlSeconds, amount);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      return redis.setNx(k(key), value, ttlSeconds);
    },
    async size() {
      return redis.countByPrefix(`${keyPrefix}:`);
    },
    async clear() {
      await redis.delByPrefix(`${keyPrefix}:`);
    },
  };
}
