import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Typechecks apps/web with the local TypeScript compiler.
 *
 * WHY run tsc directly instead of a wrapper: `tsc --noEmit` is already the type checker, and adding
 * a bundler-aware wrapper would be a second implementation that can disagree with it. The config
 * sets noEmit, so this cannot write build output by accident.
 *
 * WHY a hand-rolled lint instead of ESLint: this checks the invariants that actually broke during
 * development, and each one is a real bug we hit. A general linter would not have caught them, and
 * adding ESLint + config is dependency surface with no gate value yet. Revisit if rules accumulate.
 */
const TSC = 'node_modules/typescript/bin/tsc';

function run(args) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) throw new Error(`tsc exited with code ${res.status}`);
}

if (!existsSync(join(ROOT, TSC))) {
  console.error('TypeScript is not installed. Run `npm install` first.');
  process.exit(1);
}

try {
  run([TSC, '--noEmit', '--project', join(ROOT, 'apps/web/tsconfig.json')]);
  console.log('typecheck: no type errors in apps/web');
} catch (err) {
  console.error(`typecheck FAILED: ${err.message}`);
  process.exit(1);
}