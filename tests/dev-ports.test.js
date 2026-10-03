import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { REQUIRED_PORTS, checkPorts, formatBusyPortReport, isPortFree } from '../scripts/lib/ports.mjs';

/**
 * WHY these bind real sockets instead of mocking: the check's whole question is "can this process
 * take the port?", and a mock cannot answer that. Holding an OS-assigned ephemeral port makes the
 * busy case genuinely busy, so the test cannot pass for the wrong reason.
 */

/** Claims an ephemeral port, runs the body with it, then releases it. */
async function holding(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('isPortFree', () => {
  it('reports false while a server holds the port', async () => {
    await holding(async (port) => {
      expect(await isPortFree(port)).toBe(false);
    });
  });

  it('reports true once the listener is closed', async () => {
    // WHY this second case matters: a checker that always returned false would "pass" the test
    // above while making `npm run dev` unusable, since it would always claim a conflict.
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('checkPorts', () => {
  it('marks a held port as busy', async () => {
    await holding(async (port) => {
      const results = await checkPorts([{ port, label: 'test held' }]);
      expect(results).toEqual([{ port, label: 'test held', free: false }]);
    });
  });

  it('returns one entry per requested port, preserving order and label', async () => {
    const results = await checkPorts([
      { port: 1, label: 'first' }, { port: 2, label: 'second' },
    ]);
    expect(results.map((r) => r.label)).toEqual(['first', 'second']);
  });
});

describe('REQUIRED_PORTS', () => {
  it('covers exactly the ports AGENTS.md documents', () => {
    // WHY assert the set rather than its length: a dropped port would still leave a plausible
    // count while no longer checking a service that genuinely binds one.
    expect(REQUIRED_PORTS.map((p) => p.port).sort((a, b) => a - b))
      .toEqual([5173, 8080, 8082, 8090, 8091, 8092, 8093, 8094]);
  });

  it('labels every port so a conflict report is actionable', () => {
    for (const p of REQUIRED_PORTS) expect(p.label.length).toBeGreaterThan(0);
  });
});

describe('formatBusyPortReport', () => {
  it('names every busy port and states the next step', () => {
    const text = formatBusyPortReport([
      { port: 8082, label: 'gateway (Express)' },
      { port: 5173, label: 'web (Vite)' },
    ]);
    expect(text).toContain(':8082');
    expect(text).toContain('gateway (Express)');
    expect(text).toContain(':5173');
    // WHY assert the remedy: refusing to start is only useful if the reader is told what to do.
    expect(text.toLowerCase()).toContain('stop the process');
  });
});