import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryKeyValueStore, createDiskKeyValueStore,
} from '../src/backends/keyvalue.js';
import { KEY_VALUE_CONFORMANCE, expectConformance } from './conformance/keyvalue.conformance.js';

const TMP = mkdtempSync(join(tmpdir(), 'kv-conformance-'));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * WHY run the SAME assertions against each backend: this is what proves the interface is a real
 * contract. If memory passes and disk fails, the interface was wrong, not the backend.
 */
const backends = [
  ['memory', () => createMemoryKeyValueStore()],
  ['disk', () => createDiskKeyValueStore({ dir: join(TMP, 'disk') })],
];

for (const [name, make] of backends) {
  describe(`KeyValueStore conformance: ${name}`, () => {
    let store;
    beforeEach(async () => {
      // WHY await: the disk factory hydrates from disk, so it is async. Awaiting a non-promise
      // is harmless, so both factories share this call shape.
      store = await make();
      await store.clear();
    });

    test('passes every conformance check', async () => {
      const results = await KEY_VALUE_CONFORMANCE.run(store, { prefix: name });
      const summary = expectConformance(results);
      // Report the failing names so a failure is diagnosable from the test output alone.
      expect(summary.failed, `failed checks: ${summary.failed.join(', ')}`).toEqual([]);
      expect(summary.passed).toBe(summary.total);
      expect(summary.total).toBeGreaterThan(0);
    });
  });
}

describe('KeyValueStore conformance: Redis adapter shape', () => {
  test('refuses to start without a url or an injected client', async () => {
    // WHY this is a test and not a runtime error deep in a request: an adapter that cannot possibly
    // work must fail at construction, where the stack trace points at the config that caused it.
    const { createRedisKeyValueStore } = await import('../src/backends/keyvalue.js');
    expect(() => createRedisKeyValueStore({})).toThrow(/requires a url/);
    expect(() => createRedisKeyValueStore({ url: 'redis://x' })).toThrow(/injected client/);
  });
});

describe('KeyValueStore: TTL expiry actually expires', () => {
  test('an entry past its TTL is treated as absent', async () => {
    // WHY an injected clock: sleeping in a test would be slow and flaky. The clock is the seam.
    let t = 1_000_000;
    const store = createMemoryKeyValueStore({ clock: () => t });
    await store.set('expiring', 'v', { ttlSeconds: 10 });
    expect(await store.get('expiring')).not.toBeNull();
    t += 9_000;
    expect(await store.get('expiring')).not.toBeNull();
    t += 2_000; // now past the 10s window
    expect(await store.get('expiring')).toBeNull();
  });

  test('an expired counter restarts rather than resuming', async () => {
    let t = 2_000_000;
    const store = createMemoryKeyValueStore({ clock: () => t });
    expect(await store.increment('c', 60)).toBe(1);
    expect(await store.increment('c', 60)).toBe(2);
    t += 61_000; // window elapsed
    expect(await store.increment('c', 60)).toBe(1);
  });
});

describe('KeyValueStore: disk backend survives a restart', () => {
  test('state written by one instance is visible to the next', async () => {
    // WHY this test exists: the first version of the disk backend serialised a stale seed object
    // and never hydrated the in-memory map, so a restart silently lost every key. Persistence that
    // does not restore is worse than no persistence, because it looks like it works.
    const dir = join(TMP, 'restart');
    const first = await createDiskKeyValueStore({ dir });
    await first.set('persisted', 'value', { ttlSeconds: 0 });
    const second = await createDiskKeyValueStore({ dir });
    expect((await second.get('persisted'))?.value).toBe('value');
  });

  test('a deleted key is NOT resurrected by a restart', async () => {
    // WHY: flush() used to re-serialise the seed `entries` object, which brought deleted keys back.
    const dir = join(TMP, 'resurrect');
    const first = await createDiskKeyValueStore({ dir });
    await first.set('gone', 1);
    await first.delete('gone');
    const second = await createDiskKeyValueStore({ dir });
    expect(await second.get('gone')).toBeNull();
  });

  test('an entry that expired while the process was down is not revived', async () => {
    const dir = join(TMP, 'expired');
    const first = await createDiskKeyValueStore({ dir });
    await first.set('stale', 'v', { ttlSeconds: 1 });
    // Simulate the process being down past the TTL.
    const { writeFileSync, readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(join(dir, 'kv.json'), 'utf8'));
    raw.stale.expiresAt = Date.now() - 60_000;
    writeFileSync(join(dir, 'kv.json'), JSON.stringify(raw), 'utf8');
    const second = await createDiskKeyValueStore({ dir });
    expect(await second.get('stale')).toBeNull();
  });

  test('a corrupt cache file does not crash construction', async () => {
    // WHY: the cache is never the source of truth, so unreadable cache state must not be an outage.
    const dir = join(TMP, 'corrupt');
    const a = await createDiskKeyValueStore({ dir });
    await a.set('x', 1);
    const { writeFileSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    writeFileSync(j(dir, 'kv.json'), '{ not json', 'utf8');
    const b = await createDiskKeyValueStore({ dir });
    expect(await b.get('x')).toBeNull();
    await b.set('y', 2);
    expect((await b.get('y'))?.value).toBe(2);
  });
});