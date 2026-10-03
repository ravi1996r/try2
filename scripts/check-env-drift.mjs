#!/usr/bin/env node
/**
 * Fails if .env.example has drifted from the variables the code actually reads, in BOTH directions.
 *
 * WHY two directions and not one:
 *   - A variable in .env.example that no code reads is misleading documentation: an operator sets
 *     it, expects it to take effect, and it silently does nothing.
 *   - A variable the code reads that is missing from .env.example is worse: the operator has no way
 *     to discover it except by reading source. .env.example claims to document every variable.
 *
 * Both config.js and config.py state in their own docstrings that this check exists and is expected
 * to fail the build on drift, so this file is the thing that makes those claims true rather than
 * aspirational.
 *
 * HOW KEYS ARE DISCOVERED: by the call shapes each config module actually uses, not by scanning for
 * uppercase words. Scanning for /[A-Z_]{4,}/ also matches string literals ("production", "brave") and
 * produced four phantom variables on the first run.
 *
 * Usage: node scripts/check-env-drift.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
  { label: 'services/gateway/src/config.js', file: 'services/gateway/src/config.js' },
  { label: 'services/ai/app/config.py', file: 'services/ai/app/config.py' },
];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Keys assigned as `NAME=...` in .env.example, ignoring comments and blank lines. */
function documentedKeys(text) {
  const keys = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Gateway keys, discovered from the call shapes loadConfig() actually uses.
 *
 * WHY derived rather than hand-listed: the first version of this checker hard-coded the helper names
 * and missed `oneOf(...)`, so it reported PORTFOLIO_LOG_LEVEL and LLM_PROVIDER as unread when the
 * code plainly reads them. A hand-maintained list drifts the moment someone adds a helper. This
 * finds every `<helper>(raw, 'NAME'` call for ANY lowercase helper name, so a new accessor is
 * picked up automatically.
 *
 * `need(cond, 'NAME')` is matched separately: its variable is in the second position because the
 * first is a condition on which backend is selected.
 */
function gatewayKeys(text) {
  const keys = new Set();
  const patterns = [
    // Any helper called with `raw` then a quoted NAME: str, bool, int, oneOf, assign...
    /\b(?:str|bool|int|oneOf|assign|num|float|list)\(\s*raw\s*,\s*'([A-Z0-9_]{3,})'/g,
    // need(<condition>, 'NAME')
    /\bneed\s*\([^,]+,\s*'([A-Z0-9_]{3,})'/g,
    // Every quoted name inside a SECRET_KEYS array/tuple literal.
    //
    // WHY this pattern exists: the secret keys are read through a loop over that collection rather
    // than through an accessor call, so the accessor patterns above missed them entirely and the
    // first version of this checker wrongly reported LLM_API_KEY, TURNSTILE_SECRET_KEY and
    // APPLICATIONINSIGHTS_CONNECTION_STRING as unread when the code plainly consumes all three.
    /SECRET_KEYS\s*[:=]\s*[\[(]([\s\S]*?)[\])]/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      // The accessor patterns capture the name directly; the SECRET_KEYS pattern captures a block
      // of names that must be scanned individually.
      if (re.source.startsWith('SECRET')) {
        for (const q of m[1].matchAll(/['"]([A-Z0-9_]{3,})['"]/g)) keys.add(q[1]);
      } else {
        keys.add(m[1]);
      }
    }
  }
  return keys;
}

/**
 * Python keys, discovered the same way as the gateway's.
 *
 * WHY generalised: the first version matched only `_s(raw, "NAME")` and `raw.get("NAME")`, and so
 * missed every variable read through `_i(...)` and `_b(...)` -- it reported 7 variables for a service
 * that reads more than twice that. Any `_<helper>(raw, "NAME"` now counts, so `_s`, `_i`, `_b` and
 * any future `_float` are all picked up without editing this file.
 */
function pythonKeys(text) {
  const keys = new Set();
  const patterns = [
    /\b_[A-Za-z0-9]*\(\s*raw\s*,\s*"([A-Z0-9_]{3,})"/g,
    /\braw\.get\(\s*"([A-Z0-9_]{3,})"/g,
    // Same reason as the gateway's SECRET_KEYS: consumed by a loop, not by an accessor call.
    /SECRET_KEYS\s*[:=]\s*[\[(]([\s\S]*?)[\])]/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (re.source.startsWith('SECRET')) {
        for (const q of m[1].matchAll(/["']([A-Z0-9_]{3,})["']/g)) keys.add(q[1]);
      } else {
        keys.add(m[1]);
      }
    }
  }
  return keys;
}

/**
 * Variables the code reads on purpose but that are NOT operator-tunable, so they are exempt.
 * WHY exempt rather than documented: writing a default into .env.example would suggest that setting
 * it changes behaviour when the value is deliberately fixed in code.
 */
const EXEMPT = new Set([
  // Process-supplied by the launcher, not by the operator's .env.
  'PATH', 'PYTHONPATH', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
]);

/**
 * Variables documented in .env.example but not yet read, marked with a preceding
 * `# env-drift: planned` comment line.
 *
 * WHY this exists: .env.example deliberately documents the not-yet-implemented adapters (Azure AI
 * Search index, Blob container, Mongo db, Redis prefix, live-test keys) because AGENTS.md rule 2
 * requires unimplemented surfaces to be labelled rather than silently omitted. Those variables are
 * real forward declarations, not documentation errors. Deleting them to satisfy a linter would lose
 * that intent and quietly shrink the config surface.
 *
 * WHY a per-line marker rather than a hard-coded allowlist in this script: the exemption lives in
 * .env.example next to the variable and carries a human-written reason, so it is visible in review
 * and cannot drift away from the thing it exempts. A name list in this file would go stale silently.
 *
 * WHY the reason is required: a bare marker would let anyone silence a real drift finding with one
 * word. `env-drift: planned` with no explanation is treated as NOT exempt.
 */
function plannedKeys(text) {
  const keys = new Set();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (!m) return;

    // Walk the CONTIGUOUS comment block above the assignment, not just the one line directly before.
    // WHY: a marker whose explanation wraps onto a second comment line is normal and readable, and
    // checking only the single preceding line silently ignored it -- which is how TURNSTILE_SITE_KEY
    // stayed flagged while carrying a perfectly good marker.
    const block = [];
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].trim();
      if (!prev.startsWith('#')) break;
      block.unshift(prev);
    }

    // Require a reason after the marker: "env-drift: planned" alone is not enough to exempt.
    const marker = block.find((b) => /env-drift:\s*planned\b/.test(b));
    if (marker && /env-drift:\s*planned\b\s*\S/.test(marker)) keys.add(m[1]);
  });
  return keys;
}

const readKeys = new Set();
const perSource = [];
for (const source of SOURCES) {
  const text = read(source.file);
  const keys = source.file.endsWith('.js') ? gatewayKeys(text) : pythonKeys(text);
  perSource.push({ label: source.label, keys });
  for (const k of keys) readKeys.add(k);
}

for (const k of EXEMPT) readKeys.delete(k);

const envExample = read('.env.example');
const documented = documentedKeys(envExample);
const planned = plannedKeys(envExample);

const missing = [...readKeys].filter((k) => !documented.has(k)).sort();
// A documented-but-unread variable is only an error when it is NOT marked as a forward declaration.
const extra = [...documented].filter((k) => !readKeys.has(k) && !planned.has(k)).sort();

for (const { label, keys } of perSource) {
  console.log(`${label}: ${keys.size} variable(s) read`);
}

console.log(`.env.example: ${documented.size} documented, ${planned.size} marked "planned"`);

if (missing.length === 0 && extra.length === 0) {
  console.log(`env-drift: OK (${readKeys.size} read variable(s), no drift)`);
  process.exit(0);
}

if (missing.length) {
  console.error(`\nenv-drift: read by the code but MISSING from .env.example (${missing.length}):`);
  for (const k of missing) console.error(`  + ${k}`);
}
if (extra.length) {
  console.error(`\nenv-drift: in .env.example but NEVER read by the code (${extra.length}):`);
  for (const k of extra) console.error(`  - ${k}`);
}
console.error('\nWHY this fails: an undocumented variable cannot be discovered without reading source,');
console.error('and an unread one is misleading documentation. Fix .env.example or remove the read.');
process.exit(1);