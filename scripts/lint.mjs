/**
 * Project lint gate.
 *
 * WHY this checks these specific rules and not general style: every rule below corresponds to a
 * defect that actually occurred in this repo, or to an invariant whose violation would be silent.
 * A general-purpose linter (ESLint + config) would be real dependency surface that still would not
 * have caught any of them. Revisit if the rule list grows past what belongs in one file.
 *
 * DESIGN: no dependencies, Node built-ins only, so it runs before `npm install` has ever been
 * attempted -- same property as scripts/run.mjs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'web', 'src');

/** Files and directories never worth walking. */
const SKIP = new Set(['node_modules', 'dist', '.git', '.venv', '.serena', '__pycache__', 'data']);

/** @returns {string[]} every source file under `dir`, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(full))) out.push(full);
  }
  return out;
}

/**
 * The rules. Each returns a list of human-readable problems for one file.
 *
 * @type {Array<{id: string, why: string, check: (src: string, file: string) => string[]}>}
 */
const RULES = [
  {
    id: 'no-inline-script',
    why: 'script-src is \'self\' with no \'unsafe-inline\'. An inline <script> would be blocked.',
    check: (src, file) => {
      const problems = [];
      src.split('\n').forEach((line, i) => {
        if (/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(line)) {
          problems.push(`${file}:${i + 1} inline <script> violates the CSP`);
        }
      });
      return problems;
    },
  },
  {
    id: 'no-dangerously-set-inner-html',
    // WHY this one: model output is untrusted by design (AGENTS.md). Assigning it to innerHTML
    // would be the single point of failure this project's strict CSP exists to prevent.
    why: 'Model output is untrusted; innerHTML would execute attacker-controlled markup.',
    check: (src, file) => (src.includes('dangerouslySetInnerHTML')
      ? [`${file} uses dangerouslySetInnerHTML`]
      : []),
  },
  {
    id: 'no-console-debug',
    // WHY allow console.warn/error: those are the project's deliberate "report the failure" path.
    // Banning them would push failures into silence, which AGENTS.md forbids.
    why: 'Leftover console.log is debugging noise; console.warn/error are the failure-reporting path.',
    check: (src, file) => src.split('\n').flatMap((line, i) => (
      /console\.log\(/.test(line) ? [`${file}:${i + 1} stray console.log`] : []
    )),
  },
  {
    id: 'no-var',
    why: 'const/let only; `var` leaks function scope and defeats TDZ checks.',
    check: (src, file) => src.split('\n').flatMap((line, i) => (
      /^\s*var\s/.test(line) ? [`${file}:${i + 1} uses var`] : []
    )),
  },
  {
    id: 'no-trailing-whitespace',
    // WHY the \r carve-out: the first version of this rule used /\s$/, which matches the CR of a
    // CRLF line ending. On Windows every source file then reported 100+ "trailing whitespace" that
    // did not exist, so the gate would fail on a clean checkout. Strip the CR before testing.
    why: 'Trailing spaces/tabs produce noisy diffs; CRLF line endings are NOT whitespace errors.',
    check: (src, file) => src.split('\n').flatMap((line, i) => {
      const bare = line.replace(/\r$/, '');
      return /[ \t]$/.test(bare) ? [`${file}:${i + 1} trailing whitespace`] : [];
    }),
  },
];

let failures = 0;
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, 'utf8');
  for (const rule of RULES) {
    for (const problem of rule.check(src, rel)) {
      console.error(`  ${problem}`);
      failures += 1;
    }
  }
}

if (failures > 0) {
  console.error(`\nlint: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log(`lint: clean (${RULES.length} rules over apps/web/src)`);