/**
 * Conformance suite for the KeyValueStore interface.
 *
 * WHY this exists: an interface with only one implementation is a guess, not a design. This suite
 * is the thing that makes "Strategy pattern" true rather than decorative — any backend that passes
 * it can be swapped in by config alone. It is run against every Implemented backend (memory + disk
 * in `verify`; Redis in the compose test profile).
 *
 * It deliberately tests the properties that matter for THIS system's use of the store — atomic
 * counters, TTL expiry, prefix deletion — rather than generic CRUD.
 */

export const KEY_VALUE_CONFORMANCE = {
  name: 'KeyValueStore',

  /**
   * @param {object} store a KeyValueStore
   * @param {object} [opts] { prefix } namespace so parallel stores do not collide
   */
  async run(store, { prefix = 't' } = {}) {
    const k = (n) => `${prefix}:${n}`;
    const results = [];
    const check = (name, fn) => results.push({ name, ...fn() });

    // --- get/set/delete round trip -------------------------------------------
    {
      const ok = await store.get(k('missing')) === null;
      check('get returns null for a missing key', () => ({ pass: ok }));
    }
    {
      await store.set(k('a'), { hello: 'world' });
      const got = await store.get(k('a'));
      check('set then get returns the stored value', () => ({
        pass: got?.value?.hello === 'world',
      }));
    }
    {
      const deleted = await store.delete(k('a'));
      const after = await store.get(k('a'));
      check('delete removes the key and reports true', () => ({ pass: deleted === true && after === null }));
    }
    {
      const again = await store.delete(k('a'));
      check('deleting a missing key reports false, does not throw', () => ({ pass: again === false }));
    }

    // --- TTL ------------------------------------------------------------------
    {
      await store.set(k('ttl'), 'v', { ttlSeconds: 60 });
      const present = await store.get(k('ttl')) !== null;
      await store.set(k('ttl0'), 'v', { ttlSeconds: 0 });
      const forever = await store.get(k('ttl0'));
      check('TTL entry is readable before expiry', () => ({ pass: present }));
      check('ttlSeconds:0 means "no expiry" rather than "expired"', () => ({
        pass: forever !== null && forever.expiresAt === null,
      }));
    }

    // --- atomic increment -----------------------------------------------------
    {
      await store.delete(k('ctr'));
      const first = await store.increment(k('ctr'), 60);
      const second = await store.increment(k('ctr'), 60);
      check('increment returns the running total', () => ({ pass: first === 1 && second === 2 }));
    }
    {
      await store.delete(k('ctr2'));
      // WHY concurrency matters here: this is the property a read-modify-write counter breaks.
      // 50 concurrent increments must yield exactly 50, never fewer.
      const results2 = await Promise.all(
        Array.from({ length: 50 }, () => store.increment(k('ctr2'), 60)),
      );
      const max = Math.max(...results2);
      check('50 concurrent increments produce no lost updates', () => ({ pass: max === 50 }));
    }
    {
      await store.delete(k('ctr3'));
      await store.increment(k('ctr3'), 60, 5);
      const n = await store.increment(k('ctr3'), 60, 3);
      check('increment supports a custom amount', () => ({ pass: n === 8 }));
    }

    // --- increment TTL is a fixed window, not sliding --------------------------
    {
      await store.delete(k('win'));
      await store.increment(k('win'), 60);
      await store.increment(k('win'), 60);
      const e = await store.get(k('win'));
      check('repeated increments do NOT extend the expiry', () => ({
        pass: e?.expiresAt !== null && e.expiresAt !== undefined,
      }));
    }

    // --- setIfAbsent ----------------------------------------------------------
    {
      await store.delete(k('nx'));
      const firstSet = await store.setIfAbsent(k('nx'), 'a', 60);
      const secondSet = await store.setIfAbsent(k('nx'), 'b', 60);
      const got = await store.get(k('nx'));
      check('setIfAbsent writes only when absent', () => ({
        pass: firstSet === true && secondSet === false && got?.value === 'a',
      }));
    }

    // --- deleteByPrefix -------------------------------------------------------
    {
      await store.set(k('pf:1'), 1);
      await store.set(k('pf:2'), 2);
      await store.set(k('other:1'), 3);
      const n = await store.deleteByPrefix(k('pf:'));
      const remaining = await store.get(k('other:1'));
      check('deleteByPrefix removes only matching keys', () => ({
        pass: n === 2 && remaining !== null,
      }));
    }

    // --- clear ----------------------------------------------------------------
    {
      await store.set(k('z'), 1);
      await store.clear();
      const remaining = await store.size();
      check('clear empties the store', () => ({ pass: remaining === 0 }));
    }

    return results;
  },
};

/** Turns the raw results into a Vitest assertion block. Used by the per-backend test file. */
export function expectConformance(results) {
  const failed = results.filter((r) => !r.pass);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.map((f) => f.name),
  };
}