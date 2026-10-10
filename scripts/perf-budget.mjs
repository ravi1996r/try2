/**
 * The performance gate. Fails CI when the hero bundle or the lazy scene chunk grows past its budget.
 *
 * WHY a script and not a vitest test: the numbers being checked are the gzipped size of files on disk
 * AFTER a production build. A unit test that asserts on a constant would pass even if the bundle
 * tripled, because nothing would have rebuilt it. This runs after `npm run build` and reads the real
 * artifacts.
 *
 * WHY gzipped and not raw: gzip is what the visitor downloads. A raw byte count would pass a bundle
 * that compresses beautifully and fails one that is already dense, which is the wrong trade for a
 * portfolio whose first paint is the whole point.
 *
 * WHY it does not delete dist/: the E2E suite runs against it immediately afterwards, so removing it
 * here would force a rebuild.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'apps/web/dist';
const ASSETS = join(DIST, 'assets');

/**
 * WHY the budgets are imported from TypeScript: they are ALSO needed at runtime, where the scene
 * degrades on a low measured frame rate. Two copies would let CI pass a bundle the browser then
 * throttles. Node 24 strips the types natively, so a `.ts` import needs no build step.
 */
const { BUNDLE_BUDGET, budgetReport, summarizeBudgets } = await import(
  '../apps/web/src/perf-budget.ts'
);

function findChunk(prefix) {
  if (!existsSync(ASSETS)) return null;
  const match = readdirSync(ASSETS)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.js'))
    .map((f) => ({ f, bytes: statSync(join(ASSETS, f)).size }))
    .sort((a, b) => b.bytes - a.bytes)[0];
  return match ? join(ASSETS, match.f) : null;
}

const gzipped = (path) => gzipSync(readFileSync(path)).length;

const reports = [];
let missing = [];

for (const [name, prefix, budget] of [
  ['hero main.js', 'main', BUNDLE_BUDGET.main],
  ['lazy Scene.js', 'Scene', BUNDLE_BUDGET.scene],
]) {
  const file = findChunk(prefix);
  if (!file) {
    // WHY a missing chunk is a failure and not a skip: `main.js` absent means the build did not produce
    // a bundle at all. Reporting that as "no budget to check" would turn a broken build into a green one.
    missing.push(`${name} (no file starting with "${prefix}" in dist/assets)`);
    continue;
  }
  reports.push(budgetReport(name, gzipped(file), budget));
}

let cssBytes = 0;
// WHY site.css is the expected name: the Python generator owns it (see docs/11-adr-0011), so Vite never
// emits a CSS file of its own. Looking for main.css here reported a successful build as broken.
const cssFile = join(ASSETS, 'site.css');
if (existsSync(cssFile)) cssBytes = gzipped(cssFile);
else missing.push('hero CSS (no site.css in dist/assets -- the Python generator owns it)');

if (cssBytes > 0) reports.push(budgetReport('hero CSS', cssBytes, BUNDLE_BUDGET.css));

for (const r of reports) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${r.name.padEnd(16)} ${String(r.actual).padStart(7)} B  ${r.usedPercent}% of ${r.budget} B`);
}

if (missing.length > 0) {
  console.error('');
  console.error('PERF BUDGET FAILED: expected artifacts are missing from dist/.');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('');
  console.error('Run "npm run build" first. A missing chunk is a failed build, not an unchecked budget.');
  process.exit(1);
}

const { ok, message } = summarizeBudgets(reports);
console.log('');
console.log(ok ? `PERF BUDGET PASSED: ${message}` : `PERF BUDGET FAILED: ${message}`);
if (!ok) {
  console.error('');
  console.error('To fix: split a dependency, or lower the budget in apps/web/src/perf-budget.ts AND');
  console.error('record why in docs/14-decision-log.md. Lowering a budget to make CI pass is not a fix.');
}
process.exit(ok ? 0 : 1);