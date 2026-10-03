#!/usr/bin/env node
/**
 * Task runner for every root npm script.
 *
 * WHY this file exists: package.json referenced scripts/run.mjs for a dozen commands, but the file
 * was never written, so `npm run verify` failed with "Cannot find module". A gate that cannot run is
 * worse than no gate, because it reads as protection. This implements it for real.
 *
 * DESIGN RULES
 *   * No dependencies. Node built-ins only, so the runner works before `npm install` has ever run.
 *   * Fail fast and LOUDLY. Every task prints a banner, and the first failure aborts with the name
 *     of the task that failed. A gate that continues past an error is not a gate.
 *   * No silent skips. A missing tool produces a named, actionable error, never a quiet pass.
 *   * Cross-platform. No shell-specific syntax; spawn with shell:false and an argv array.
 *
 * USAGE
 *   node scripts/run.mjs <task> [task...]     run the named tasks in order
 *   node scripts/run.mjs --list               list every task and what it runs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolves the repo Python interpreter, preferring the venv AGENTS.md documents. */
function pythonBin() {
  const venv = process.platform === 'win32'
    ? join(ROOT, '.venv', 'Scripts', 'python.exe')
    : join(ROOT, '.venv', 'bin', 'python');
  // WHY fall back to bare `python`: a fresh clone has no venv yet, and failing with "spawn python
  // ENOENT" is a worse error than trying the system interpreter and letting pytest report properly.
  return existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
}

const VITEST = 'node_modules/vitest/vitest.mjs';

/**
 * Resolves how to spawn an npm workspace build as a [binary, argv[]] pair.
 *
 * WHY not the bare string "npm": the runner spawns with shell:false, and on Windows "npm" is a
 * shell script (npm.cmd), which a bare CreateProcess cannot launch. When npm invoked us it exports
 * `npm_execpath`, the real JS entry point; running it with the current node binary sidesteps the
 * .cmd shim on every platform.
 */
function npmBuild() {
  const entry = process.env.npm_execpath;
  if (entry && existsSync(entry)) {
    return [process.execPath, [entry, 'run', 'build', '--workspace', '@portfolio/web']];
  }
  return ['npm', ['run', 'build', '--workspace', '@portfolio/web']];
}

/**
 * Tasks are declared as data so `--list` and the runner cannot disagree.
 * `cmd` is [binary, argv[]] so nothing goes through a shell.
 */
const TASKS = {
  'validate:content': {
    desc: 'Validate content/profile.json against its JSON Schema',
    cmd: ['node', ['scripts/validate-content.mjs']],
  },

  'build:site': {
    desc: 'Generate the prerendered index.html and CSS from profile.json',
    cmd: [pythonBin(), ['scripts/build_static_site.py']],
  },

  'build:web': {
    desc: 'Bundle the React enhancement into dist/assets/main.js (Vite, no HTML emitted)',
    // WHY this runs AFTER build:site: Vite is configured with emptyOutDir:false and writes only
    // main.js, so the generator's index.html and site.css survive. Order matters only for clarity
    // and so a missing main.js in the output is obviously this step's failure.
    cmd: npmBuild(),
  },

  build: {
    desc: 'Prerender the site, then bundle the React enhancement',
    group: ['build:site', 'build:web'],
  },

  'test:unit:web': {
    desc: 'Static-site generator tests: escaping, a11y structure, reveal-field omission',
    cmd: [pythonBin(), ['-m', 'pytest', 'services/ai/tests/test_static_site.py', '-q']],
  },

  'test:unit': {
    desc: 'JS unit + contract tests (vitest)',
    cmd: ['node', [VITEST, 'run']],
  },

  'test:unit:py': {
    desc: 'Python unit tests (pytest)',
    cmd: [pythonBin(), ['-m', 'pytest', 'services/ai/tests', '-q']],
  },

  lint: {
    desc: 'Project lint rules over apps/web/src (no-inline-script, no-innerHTML, no var, ...)',
    cmd: ['node', ['scripts/lint.mjs']],
  },

  'typecheck': {
    desc: 'Typecheck apps/web (tsc --noEmit against the web tsconfig)',
    cmd: ['node', ['scripts/typecheck.mjs']],
  },

  dev: {
    desc: 'Start web + gateway + AI service + fake providers (checks ports first)',
    cmd: ['node', ['scripts/dev.mjs']],
  },

  'test:live': {
    desc: 'Opt-in: does each configured REAL provider answer? (needs ALLOW_LIVE_TESTS=1 + a key)',
    cmd: ['node', ['scripts/live-check.mjs', 'live']],
  },

  'evals:live': {
    desc: 'Opt-in: run the authored starter questions against REAL providers',
    cmd: ['node', ['scripts/live-check.mjs', 'evals']],
  },

  'perf:local': {
    desc: 'Measure FPS and heap in Chromium against the built site (real GPU, no threshold)',
    cmd: ['node', ['scripts/perf-local.mjs']],
  },

  load: {
    desc: 'Concurrency + latency against the local fake provider (no real provider calls)',
    cmd: ['node', ['scripts/load-test.mjs']],
  },

  'data:reset': {
    desc: 'Delete the derived data/ contents (index, caches, blobs); refuses paths outside the repo',
    cmd: ['node', ['scripts/data-reset.mjs']],
  },

  'index:rebuild': {
    desc: 'Rebuild the local retrieval index from content/profile.json',
    cmd: [pythonBin(), ['-m', 'services.ai.app.ingest']],
  },

  traceability: {
    desc: 'Regenerate docs/requirements-traceability.md from the feature table',
    cmd: ['node', ['scripts/generate-traceability.mjs']],
  },

  'test:integration': {
    desc: 'Cross-process: gateway -> Python AI service -> fake provider, as real processes',
    // WHY a separate vitest config: these tests bind ports and spawn a Python interpreter, which
    // must not share a worker pool with the fast unit suite.
    cmd: ['node', [VITEST, 'run', '--config', 'vitest.integration.config.js']],
  },

  'test:e2e': {
    desc: 'Playwright: the built site in Chromium + axe a11y against the real CSP',
    // WHY this runs against `dist` served with the GATEWAY's own securityHeaders() rather than the
    // Vite dev server: the artifact under test is the prerendered HTML plus the built bundle, and
    // the dev server serves neither the CSP nor the production script. A dev-only suite could not
    // detect the failure that matters most -- the production CSP blocking the production bundle.
    cmd: ['node', [join('node_modules', '@playwright', 'test', 'cli.js'), 'test']],
  },

  'secret-scan': {
    desc: 'Scan the working tree for secret-shaped strings',
    cmd: ['node', ['scripts/secret-scan.mjs']],
  },

  'security:mutation': {
    desc: 'Weaken the CSP on purpose and prove the header tests catch it',
    // WHY this is a gate and not a one-off: a security test suite that has only ever passed is
    // unverified. This proves the tests are load-bearing by breaking the policy and requiring a
    // failure. It restores the original file even when a mutation is missed.
    cmd: [pythonBin(), ['scripts/mutation_check.py']],
  },

  'env:drift': {
    desc: 'Check .env.example against the variables the code actually reads',
    cmd: ['node', ['scripts/check-env-drift.mjs']],
  },

  'verify:fast': {
    desc: 'Fast gate: content + generator tests + unit tests + secret scan + env drift',
    // WHY verify:fast includes the secret scan and the env drift check: both are fast, and both
    // catch a class of defect (a committed credential, a documented variable the code ignores) that
    // only surfaces in review if a gate looks for it. Deferring them to the slow gate means they
    // run less often than they should.
    group: ['validate:content', 'test:unit:web', 'lint', 'typecheck', 'test:unit', 'test:unit:py',
      'secret-scan', 'security:mutation', 'env:drift'],
  },

  verify: {
    desc: 'Full gate: build both halves, then the fast gate against the real artifacts',
    // HONEST SCOPE: this is the full gate for everything implemented so far. It does NOT yet include
    // the integration, security-header, E2E or a11y-browser gates from AGENTS.md, because those
    // suites do not exist yet. Claiming them would be a false claim; docs/PROGRESS.md records the
    // gap. Add them here as they land.
    //
    // WHY `build` runs BEFORE `verify:fast`, not after: the CSP tests assert against the real
    // dist/index.html and dist/assets/main.js. Building afterwards would let them skip on a clean
    // tree, and AGENTS.md requires zero skipped tests in the gate -- a skip is a silent pass.
    // HONEST SCOPE: this is the full gate for everything implemented so far. `test:integration` boots the
    // real AI service + fake provider + gateway as separate processes and drives a chat turn through
    // them, and `test:e2e` serves the built artifact with the gateway's real CSP. What is still NOT
    // covered: the live-provider suites (they need real keys), perf/load harnesses, and the Three.js
    // scenes, which do not exist yet. docs/PROGRESS.md records the remainder.
    group: ['build', 'verify:fast', 'test:integration', 'test:e2e'],
  },
};

/**
 * Tasks declared in package.json that are NOT implemented yet.
 *
 * WHY this list exists rather than letting them fail with "Cannot find module": a confusing ENOENT
 * reads as a broken checkout, when the truth is the task has not been written. Each entry names
 * where the work is tracked, so the message points somewhere useful instead of just refusing.
 *
 * This is a deliberate honesty measure. Leaving these silently succeeding would be worse than either
 * alternative: `npm run test:e2e` reporting success when no E2E test exists is a false claim.
 */
const NOT_YET = {
  // WHY this map is now EMPTY: every task declared in package.json is implemented. It is kept rather
  // than deleted because the runner's contract is "declared but unimplemented => exit 1 with a named
  // reason, never a silent success". Adding an entry is how a newly declared task reports itself as
  // unwritten.
  //
  // WHY the stale entries were removed: build, lint, test:live, evals:live, perf:local and load all
  // sat here with reasons that had become false. They were harmless (TASKS is checked first), but a
  // reason reading "no linter is configured yet" while a linter runs in the gate is precisely the
  // drift this file exists to prevent.
};

function banner(text) {
  const line = '='.repeat(Math.max(8, text.length + 4));
  console.log(`\n${line}\n  ${text}\n${line}`);
}

/**
 * Runs one command to completion as a promise.
 *
 * WHY the resolved-promise wrapper: a callback-style spawn cannot be awaited cleanly, and mixing
 * spawnSync with spawn would make behaviour depend on which task happened to run first.
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: false,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (err) => reject(new Error(`failed to launch "${cmd}": ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exited with code ${code}`))));
  });
}

async function runTask(name) {
  const task = TASKS[name];

  // An unimplemented task is reported honestly and non-zero, never silently skipped.
  if (!task && NOT_YET[name]) {
    throw new Error(`task "${name}" is NOT IMPLEMENTED yet: ${NOT_YET[name]}. `
      + 'Tracked in docs/PROGRESS.md.');
  }
  if (!task) {
    throw new Error(`unknown task "${name}". Run with --list to see the available tasks.`);
  }
  // A group fans out into its members, each of which reports and can fail independently.
  if (task.group) {
    for (const member of task.group) await runTask(member);
    return;
  }

  banner(`${name} — ${task.desc}`);
  const [bin, args] = task.cmd;
  if (args.includes(VITEST) && !existsSync(join(ROOT, VITEST))) {
    // WHY a named error rather than an ENOENT stack: "run npm install" is the only actionable
    // message here, and the runner is the right place to say it.
    throw new Error('vitest is not installed. Run `npm install` first.');
  }
  try {
    await run(bin, args);
  } catch (err) {
    throw new Error(`task "${name}" ${err.message}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    console.log('No task given. Available tasks:\n');
    for (const [name, task] of Object.entries(TASKS)) {
      console.log(`  ${name.padEnd(18)}  ${task.group ? `-> ${task.group.join(', ')}` : task.desc}`);
    }
    console.log('\nUsage: node scripts/run.mjs <task> [task...]');
    process.exit(1);
  }
  if (argv.includes('--list')) {
    for (const [name, task] of Object.entries(TASKS)) {
      console.log(`${name.padEnd(18)}  ${task.group ? `-> ${task.group.join(', ')}` : task.desc}`);
    }
    if (Object.keys(NOT_YET).length) {
      console.log('\nDeclared in package.json but NOT implemented yet:');
      for (const name of Object.keys(NOT_YET)) console.log(`  ${name.padEnd(18)}  ${NOT_YET[name]}`);
    }
    process.exit(0);
  }

  const started = Date.now();
  for (const name of argv) await runTask(name);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  banner(`PASSED: ${argv.join(', ')} (${seconds}s)`);
}

main().catch((err) => {
  // WHY stderr + exit 1: a gate that exits 0 on failure is worse than no gate, because CI goes green.
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
