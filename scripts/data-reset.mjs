/**
 * `npm run data:reset` — wipes the local, derived data directory.
 *
 * WHY this is guarded rather than a bare `rm -rf`: `data/` holds only DERIVED artefacts (the SQLite
 * index, caches, Drop-Zone blobs), so deleting it is safe and recoverable by rebuilding. But
 * PORTFOLIO_DATA_DIR is an environment variable, and a mistyped value pointing at a home directory
 * would make a "safe" script destructive. So the script refuses unless the resolved path is inside
 * the repo, and it never deletes the directory itself -- only its contents, preserving .gitkeep.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(process.env.PORTFOLIO_DATA_DIR || join(ROOT, 'data'));
const FORCE = process.argv.includes('--force');

/**
 * Refuses to delete anything not inside the repository.
 *
 * WHY the check exists and is not a warning: this script's whole safety claim is "data/ is derived
 * and local". The moment that claim cannot be verified, the honest response is to stop and say why.
 */
function assertInsideRepo() {
  const rel = relative(ROOT, DATA_DIR);
  const inside = rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !rel.startsWith('/'));
  if (!inside && !FORCE) {
    console.error(
      `Refusing to reset: PORTFOLIO_DATA_DIR resolves outside this repository.\n`
      + `  resolved: ${DATA_DIR}\n`
      + `  repo    : ${ROOT}\n\n`
      + 'Set PORTFOLIO_DATA_DIR to a path inside the repo, or pass --force if this is intended.',
    );
    process.exit(1);
  }
}

assertInsideRepo();

if (!existsSync(DATA_DIR)) {
  console.log(`data: nothing to reset (${relative(ROOT, DATA_DIR) || DATA_DIR} does not exist).`);
  process.exit(0);
}

const entries = readdirSync(DATA_DIR);
// WHY keep .gitkeep: the directory must stay in the repo so a fresh clone has somewhere to write.
const targets = entries.filter((e) => e !== '.gitkeep');

if (targets.length === 0) {
  console.log('data: already clean (only .gitkeep present).');
  process.exit(0);
}

// WHY report sizes: "deleted 3 items" is unfalsifiable, whereas "deleted data/index (48.2 kB)" tells
// the reader whether the wipe matched what they expected to lose.
const report = targets.map((entry) => {
  const full = join(DATA_DIR, entry);
  let size = 0;
  const measure = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) readdirSync(p).forEach((c) => measure(join(p, c)));
    else size += s.size;
  };
  try { measure(full); } catch { /* unreadable: still deleted, just unmeasured */ }
  return { entry, size };
});

for (const { entry } of report) rmSync(join(DATA_DIR, entry), { recursive: true, force: true });

const total = report.reduce((n, r) => n + r.size, 0);
console.log(`data: reset ${report.length} item(s), freed ${(total / 1024).toFixed(1)} kB`);
for (const { entry, size } of report) {
  console.log(`  - ${entry} (${(size / 1024).toFixed(1)} kB)`);
}
console.log('\nRecreate the retrieval index with: npm run index:rebuild');