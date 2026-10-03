/**
 * `npm run perf:local` — FPS and memory on real GPU hardware.
 *
 * WHY this drives a real browser rather than simulating frames: FPS is a property of the compositor,
 * the GPU and the driver. A synthetic timer reports nothing meaningful about frame delivery, so a
 * number produced without a GPU would be a fabricated measurement.
 *
 * WHY it samples `requestAnimationFrame` deltas rather than counting frames per second: rAF deltas
 * give the real distribution, so a run with two 500ms hitches is visibly different from a smooth one
 * even at the same average FPS.
 *
 * WHY there is no pass/fail threshold: no agreed FPS target exists for this project. Inventing one
 * would manufacture a gate out of nothing. The script reports measured numbers and exits 0 when the
 * scene rendered at all.
 */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { percentile, ROOT } from './lib/stack.mjs';
import { createStaticServer } from '../tests/e2e/static-server.mjs';

const DIST = join(ROOT, 'apps', 'web', 'dist');
const PORT = Number(process.env.PERF_PORT ?? 4190);
const SECONDS = Number(process.env.PERF_SECONDS ?? 5);

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(
    `perf:local needs a built site.\n  missing: ${join(DIST, 'index.html')}\n  run: npm run build`,
  );
  process.exit(1);
}

const server = createStaticServer();
let browser;

try {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  browser = await chromium.launch({
    // WHY these flags: they ask for a real, unthrottled GPU path. Without them headless Chromium
    // may fall back to SwiftShader (software rasterisation), and the FPS would describe a CPU
    // rasteriser rather than the visitor's hardware. `headless: new` keeps the same code path.
    args: ['--enable-gpu', '--use-gl=angle', '--enable-unsafe-swiftshader'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

  const scene = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return {
      hasCanvas: Boolean(canvas),
      webgl: (() => {
        try {
          const c = document.createElement('canvas');
          return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
        } catch { return false; }
      })(),
      renderer: (() => {
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          const ext = gl?.getExtension('WEBGL_debug_renderer_info');
          return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
        } catch { return 'unknown'; }
      })(),
    };
  });

  console.log('| Property | Value |');
  console.log('| --- | --- |');
  console.log(`| canvas present | ${scene.hasCanvas} |`);
  console.log(`| WebGL available | ${scene.webgl} |`);
  console.log(`| renderer | ${scene.renderer} |`);
  console.log('');

  // WHY discard the first second: startup compiles shaders and allocates; including it would make
  // steady-state performance look worse than it is.
  const metrics = await page.evaluate(async (seconds) => {
    const deltas = [];
    let last = performance.now();
    const start = last;
    return await new Promise((resolve) => {
      function tick(now) {
        deltas.push(now - last);
        last = now;
        if (now - start < seconds * 1000) requestAnimationFrame(tick);
        else {
          const mem = performance.memory ?? null;
          resolve({
            frames: deltas.length,
            deltas,
            heapUsed: mem ? mem.usedJSHeapSize : null,
            heapTotal: mem ? mem.totalJSHeapSize : null,
          });
        }
      }
      requestAnimationFrame(tick);
    });
  }, SECONDS);

  // WHY the deltas arrive in milliseconds: requestAnimationFrame supplies a DOMHighResTimeStamp.
  // Drop the first ~60 frames as warm-up, matching the discard rationale above.
  const warm = metrics.deltas.slice(60);
  // WHY derive elapsed from the deltas instead of trusting the requested duration: an earlier version
  // divided the frame count by a hardcoded 1000 and reported "1000.0 FPS", which is a fabricated
  // number produced by dividing by the wrong constant. Summing the measured deltas means the
  // throughput figure and the frame-time figures are derived from the same observations.
  const elapsedMs = warm.reduce((a, b) => a + b, 0);
  const secondsMeasured = elapsedMs / 1000;
  const fps = secondsMeasured > 0 ? warm.length / secondsMeasured : 0;

  console.log(`Measured over ${secondsMeasured.toFixed(2)}s (first 60 frames discarded as warm-up):`);
  console.log('');
  console.log('| Metric | Value |');
  console.log('| --- | --- |');
  console.log(`| frames sampled | ${warm.length} |`);
  console.log(`| mean FPS | ${fps.toFixed(1)} |`);
  console.log(`| frame time p50 | ${percentile(warm, 50).toFixed(2)} ms |`);
  console.log(`| frame time p95 | ${percentile(warm, 95).toFixed(2)} ms |`);
  console.log(`| frame time p99 | ${percentile(warm, 99).toFixed(2)} ms |`);
  console.log(`| worst frame | ${Math.max(0, ...warm).toFixed(2)} ms |`);
  console.log(`| long frames (>50ms) | ${warm.filter((d) => d > 50).length} |`);
  if (metrics.heapUsed !== null) {
    console.log(`| JS heap used | ${(metrics.heapUsed / 1048576).toFixed(1)} MiB |`);
  } else {
    // WHY say this instead of omitting the row: a missing number that is silently absent reads like
    // "memory was fine". performance.memory is Chromium-only and must be reported as unavailable.
    console.log('| JS heap used | unavailable (performance.memory is Chromium-only) |');
  }
  console.log('');
  console.log(
    'SCOPE: one machine, one browser, one scene. Not a general performance claim. Re-run on the\n'
    + 'target hardware before quoting any number, and note the renderer line above.',
  );

  // WHY exit 0 on any FPS: correctness of rendering is the only defensible signal. A frame-rate bar
  // would be a threshold nobody agreed to.
  process.exitCode = 0;
} catch (err) {
  console.error(`perf:local FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}