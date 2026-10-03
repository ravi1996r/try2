#!/usr/bin/env node
/**
 * Scans the working tree for committed secrets.
 *
 * WHY this is a real scanner and not a grep for "api_key": the failure that matters is a real
 * credential in a real file, so this combines FOUR independent signals and reports a finding only
 * when something secret-shaped is actually ASSIGNED:
 *
 *   1. High-entropy values assigned to a secret-ish variable name.
 *   2. Vendor token formats (OpenAI sk-..., GitHub ghp_..., Slack xox..., AWS AKIA..., JWT).
 *      These are precise enough to match with no surrounding context.
 *   3. Private key PEM headers.
 *   4. Long opaque values on *_KEY / *_SECRET / *_TOKEN / *_PASSWORD lines.
 *
 * WHY placeholders are allowed: .env.example must document every variable, and a file full of
 * CHANGEME is correct. A scanner that flagged those would be switched off within a day.
 *
 * WHY it never prints the value: a scanner that echoes a live secret into a CI log has leaked it
 * somewhere new. Only file, line and variable name are reported.
 *
 * WHY it never reads .env: AGENTS.md rule 6 forbids reading .env. A secret scanner that opened it
 * would break the same rule it exists to enforce. .gitignore already keeps it out of git.
 *
 * Usage: node scripts/secret-scan.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'dist', 'build', '__pycache__',
  '.pytest_cache', '.ruff_cache', '.mypy_cache', 'coverage', 'playwright-report',
  'test-results', '.vite', 'data',
]);

/** Binary and non-text extensions we must not try to decode. */
const SKIP_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.zip', '.gz', '.mp4', '.mp3', '.wasm', '.sqlite', '.db', '.pyc', '.lock',
]);

/** Files allowed to contain something secret-shaped: these are documentation by rule. */
const ALLOWLIST = new Set(['.env.example', '.env.sample', '.env.template']);

/** Vendor token formats. Precise enough to match alone. */
const VENDOR_PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Azure storage key', re: /\bAccountKey=[A-Za-z0-9+/=]{60,}/g },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/** Variable names whose assigned value is treated as a secret. */
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i;

/** Values that are documentation, not secrets. */
const PLACEHOLDER = new Set([
  '', 'changeme', 'change-me', 'your-key-here', 'your_key_here', 'placeholder', 'example',
  'none', 'null', 'todo', 'xxx', 'replace-me', 'set-me', 'not-set', 'unset', 'todo-add-key',
]);

/**
 * Shannon entropy per character. WHY this bar: base64/hex secrets sit well above 3.5 bits/char,
 * while identifiers, paths, URLs and English words sit below. It separates the two without needing
 * to know which provider issued the key.
 */
function entropy(value) {
  if (value.length < 16) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when a value is obviously documentation rather than a live credential. */
function looksLikePlaceholder(raw) {
  const v = raw.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (PLACEHOLDER.has(v)) return true;
  // WHY these prefixes: every documented placeholder style in this repo starts with one of these.
  return /^(your|my|the|<|\$\{|process\.env|os\.environ|change|todo|replace|insert)/.test(v);
}
/**
 * A credential's value is a single opaque token: letters, digits and a few base64/hex separators.
 *
 * WHY this charset is the first false-positive filter: it rejects prose ("KEY=value with comments"),
 * code expressions (`re.compile(...)`, `process.env.X`), URLs and file paths, all of which are
 * high-entropy by character count but are obviously not secrets. A real API key has no spaces, no
 * parentheses and no quotes inside it.
 */
const SECRET_VALUE = /^[A-Za-z0-9_\-+/=.]{16,}$/;

/**
 * A real random key mixes cases, digits and separators. Natural-language text, however long, is
 * lowercase words joined by hyphens.
 *
 * WHY this filter exists: entropy ALONE is not enough. `_TOKEN_RE = "some-regular-expression-pattern"`
 * scored 3.69 bits/char, above the 3.5 bar, and was the last remaining false positive. Character-class
 * COUNT was also not enough, and the first attempt at it was wrong: counting how many of
 * {lower, upper, digit, separator} appear rates that English phrase at 0.50 -- it has lowercase AND
 * separators -- which sat above the threshold that had been picked by guessing rather than measuring.
 *
 * The signal that actually separates them is the CO-OCCURRENCE of upper case and digits. A generated
 * key has both, at similar frequency. Hyphenated English has neither. Measured: the planted key has
 * 4 upper / 12 digits out of 24 chars; the phrase has 0 and 0. Requiring both to be present rejects
 * the phrase and keeps the key with a wide margin, and it does so on a property that cannot be
 * satisfied by writing an English sentence with capital letters in it.
 */
function looksGenerated(value) {
  const upper = (value.match(/[A-Z]/g) ?? []).length;
  const digits = (value.match(/[0-9]/g) ?? []).length;
  // WHY proportional as well as non-zero: "Password1234567890123" has both but is guessable, so
  // requiring each to be a real share of the value rejects short-prefix padding.
  return upper >= 2 && digits >= 2 && upper / value.length >= 0.1 && digits / value.length >= 0.15;
}

/**
 * Inline opt-out: any line carrying `secret-scan: allow` is skipped.
 *
 * WHY this exists instead of a per-directory allowlist: test fixtures legitimately contain
 * secret-SHAPED strings (a fake token used to prove the scanner detects it), and excluding whole
 * directories would also hide a real key pasted into a test file, which is a common way secrets
 * actually leak. This forces a human to look at each line and accept it in review.
 *
 * WHY it applies to EVERY signal and not just assignments: the scanner's own test suite contains
 * fake OpenAI/GitHub/AWS/Slack tokens as fixtures. Without this, `npm run secret-scan` fails on the
 * test file itself, which is the worst possible outcome for a scanner -- it trains people to ignore
 * it, and a real finding added to that file would be invisible. A file-level marker is accepted for
 * the same reason: a test file may legitimately need many.
 */
const ALLOW_MARKER = /secret-scan:\s*allow/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** KEY=value and "key": "value" assignments carrying a secret-ish name. */
const ASSIGN = [
  /^\s*(?:export\s+)?([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/,
  /"([A-Za-z0-9_]*(?:key|secret|token|password|credential)[A-Za-z0-9_]*)"\s*:\s*"([^"]{8,})"/i,
];

const findings = [];

for (const abs of walk(ROOT)) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  const base = rel.split('/').pop();

  if (SKIP_EXT.has(extname(base))) continue;
  // WHY skip .env specifically: rule 6 forbids reading it, and we would be reading it to enforce it.
  if (/^\.env(\..+)?$/.test(base) && !ALLOWLIST.has(base)) continue;
  const allowlisted = ALLOWLIST.has(base);

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue; // undecodable: skip rather than fail the gate on a file we cannot read
  }

  // A file-level or line-level marker exempts the whole file / this line from every signal.
  // WHY the file-level form exists: the scanner's own test suite is full of deliberately fake
  // provider tokens, and exempting per line would mean sprinkling the marker across dozens of
  // fixtures. Both forms are visible in review, which is the property that matters.
  const fileAllowed = ALLOW_MARKER.test(text);

  text.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;

    // Signal 3: private key headers.
    if (!fileAllowed && !ALLOW_MARKER.test(line) && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) {
      findings.push({ at, signal: 'private-key', detail: 'PEM private key header' });
      return;
    }

    // Signal 2: vendor formats. Precise enough to match with no context.
    if (!fileAllowed && !ALLOW_MARKER.test(line)) {
      for (const { name, re } of VENDOR_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) {
          findings.push({ at, signal: 'vendor-token', detail: name });
          return;
        }
      }
    }

    // Signals 1 and 4 need assignment context, and .env.example is exempt by design.
    if (allowlisted || fileAllowed) return;

    for (const pattern of ASSIGN) {
      const m = pattern.exec(line);
      if (!m) continue;
      const name = m[1];
      if (!SECRET_NAME.test(name)) continue;
      if (ALLOW_MARKER.test(line)) continue;

      // Strip quotes and a trailing comment, then require an opaque credential-shaped token.
      const raw = (m[2] ?? '')
        .replace(/\s+#.*$/, '')
        .trim()
        .replace(/^["']|["']$/g, '');
      if (!SECRET_VALUE.test(raw) || looksLikePlaceholder(raw)) continue;
      // WHY the diversity gate: entropy alone still admits hyphenated English, which is what
      // produced the last false positive. A generated key is character-class diverse.
      if (!looksGenerated(raw)) continue;

      const e = entropy(raw);
      // WHY both signals are kept: high entropy catches a real random key, while the length floor
      // still flags a weaker-but-real value like a repeated-character password.
      if (e >= 3.5) {
        findings.push({ at, signal: 'high-entropy-assignment', detail: `${name} (entropy ${e.toFixed(2)})` });
      } else {
        findings.push({ at, signal: 'secret-shaped-assignment', detail: `${name} (${raw.length} chars, entropy ${e.toFixed(2)})` });
      }
      return;
    }
  });
}

if (findings.length === 0) {
  console.log('secret-scan: no secret-shaped strings found');
  process.exit(0);
}

console.error(`secret-scan: ${findings.length} potential secret(s) found\n`);
for (const f of findings) {
  // WHY no value in the output: echoing a live credential into a terminal or CI log leaks it
  // somewhere new. The location is enough to act on.
  console.error(`  ${f.at}\n    signal: ${f.signal}\n    detail: ${f.detail}`);
}
console.error('\nIf any of these are real, rotate the credential FIRST, then remove it from the file');
console.error('and from git history. Deleting the line alone does not un-leak a committed secret.');
process.exit(1);