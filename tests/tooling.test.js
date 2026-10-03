// secret-scan: allow
//
// WHY this whole file is exempt: every secret-shaped string below is a DELIBERATE FIXTURE whose only
// purpose is to prove the scanner detects it. A scanner that fails on its own test suite is a scanner
// people learn to ignore, which is worse than no scanner, because a real finding added here would be
// invisible among the noise. The exemption is stated once, at the top, rather than on each line, so a
// reviewer sees the whole justification in one place.
//
// This does NOT weaken detection anywhere else: a real key pasted into this file is still a finding
// a human must consciously mark, and the production source tree has no marker at all.
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHY this differs from the `process.cwd()` ROOT further down: this block must resolve the repo from
 * the TEST FILE's location, because vitest's cwd depends on which workspace is running. Reusing the
 * later name here shadowed it at module scope and broke the whole file with a redeclaration error.
 */
const WEB_ROOT = join(import.meta.dirname, '..');
const DIST = join(WEB_ROOT, 'apps', 'web', 'dist');
const INDEX = join(DIST, 'index.html');
const CONFIG = readFileSync(join(WEB_ROOT, 'apps', 'web', 'vite.config.ts'), 'utf8');

/**
 * WHY this file exists: ADR-0011 chose "React layered on the generated HTML" over Next.js precisely
 * because the gateway CSP is `script-src 'self'` with no 'unsafe-inline'. Next.js inlines bootstrap
 * scripts and would have forced that concession away. If a later build change starts emitting an
 * inline <script>, the browser blocks it and the enhancement dies silently -- invisible to every
 * Python test. These assertions lock the invariant in place.
 *
 * WHY `skipIf(!hasBuild)` rather than failing hard: a bare `npx vitest run` on a clean clone would
 * otherwise fail on a missing build rather than on a real defect, and a test that fails for the
 * wrong reason trains people to ignore it. The gate runs `build` BEFORE `verify:fast`, so in
 * `npm run verify` these never skip and AGENTS.md's zero-skipped rule holds.
 */
const hasBuild = existsSync(INDEX);

describe('CSP compatibility of the prerendered artifact', () => {
  it.skipIf(!hasBuild)('contains no inline <script> body, so script-src \'self\' is satisfiable', () => {
    const html = readFileSync(INDEX, 'utf8');
    const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1].trim())
      .filter((body) => body.length > 0);
    expect(inline, 'inline scripts violate the Content-Security-Policy').toEqual([]);
  });

  it.skipIf(!hasBuild)('loads the bundle as exactly one external module script', () => {
    const html = readFileSync(INDEX, 'utf8');
    const tags = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
    expect(tags).toEqual(['/assets/main.js']);
  });

  it.skipIf(!hasBuild)('exposes the #root mount point React requires', () => {
    expect(readFileSync(INDEX, 'utf8')).toContain('<div id="root"></div>');
  });

  it.skipIf(!hasBuild)('leaves the Python generator in sole ownership of index.html', () => {
    // WHY this specific string: it is written by build_static_site.py and by nothing else. If Vite
    // ever started emitting its own index.html, this marker would vanish -- the exact regression
    // that would silently destroy the SEO and no-JS artifacts.
    expect(readFileSync(INDEX, 'utf8')).toContain('Generated at build time from the profile data');
  });

  it.skipIf(!hasBuild)('emits main.js next to it so the module reference resolves', () => {
    expect(existsSync(join(DIST, 'assets', 'main.js'))).toBe(true);
  });
});

describe('build configuration invariants', () => {
  it('sets emptyOutDir:false so Vite cannot delete the generated HTML and CSS', () => {
    // WHY assert on the source rather than the output: an output check passes until the day Vite's
    // cleanup order changes. This names the exact guard that prevents the data loss.
    expect(CONFIG).toMatch(/emptyOutDir:\s*false/);
  });

  it('disables publicDir so the resume PDF is not duplicated into the assets dir', () => {
    expect(CONFIG).toMatch(/publicDir:\s*false/);
  });

  it('points the bundle at dist/assets rather than a path outside apps/web', () => {
    // WHY: a relative URL resolves against the CONFIG FILE's directory. '../dist' emitted the
    // bundle into apps/dist, outside the served tree, while the build still reported success.
    expect(CONFIG).toMatch(/new URL\('\.\/dist\/assets'/);
  });
});

const ROOT = process.cwd();
const SCAN = join(ROOT, 'scripts', 'secret-scan.mjs');
const DRIFT = join(ROOT, 'scripts', 'check-env-drift.mjs');
const RUN = join(ROOT, 'scripts', 'run.mjs');

/**
 * WHY these tests plant real secrets in a temp directory instead of only running the scanner
 * read-only: a secret scanner that has only ever produced a clean run is completely untested. Every
 * test here writes a KNOWN-bad file and asserts the scanner notices, so a regression that silences
 * the scanner fails the suite rather than passing quietly.
 *
 * WHY the temp dir is created INSIDE the repo: the scanner walks from its own ROOT, so a file outside
 * the tree is invisible to it. Every helper removes the directory afterwards, so a failing test
 * cannot leave a fake credential behind.
 *
 * WHY the suite must not run these concurrently: the scanner walks the WHOLE repository, so it sees
 * every planted canary at once. Under parallel execution one test's planted secret made all six
 * "this should pass" tests fail -- pure cross-talk, not real defects. The sweep below plus the
 * serial ordering removes that coupling. The alternative, a --root flag on the scanner purely for
 * tests, would add production surface to serve a test concern.
 */
const CANARY_PREFIX = '.scan-canary-';

/** Removes any canary directory left behind by an interrupted run, so a rerun starts clean. */
function sweepCanaries() {
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith(CANARY_PREFIX)) rmSync(join(ROOT, entry), { recursive: true, force: true });
  }
}

afterAll(sweepCanaries);

function runScanner() {
  const r = spawnSync('node', [SCAN], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Plants files, runs the assertion, and always cleans up -- including on failure. */
function withPlanted(files, fn) {
  sweepCanaries();
  const dir = mkdtempSync(join(ROOT, CANARY_PREFIX));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    sweepCanaries();
  }
}

/** Runs the drift check against a mutated .env.example and always restores the original. */
function withMutatedEnvExample(extra, fn) {
  const target = join(ROOT, '.env.example');
  const original = readFileSync(target, 'utf8');
  try {
    writeFileSync(target, `${original}\n${extra}`, 'utf8');
    return fn();
  } finally {
    writeFileSync(target, original, 'utf8');
  }
}

describe.sequential('secret-scan', () => {
  it('passes on the real working tree', () => {
    const { code, stdout } = runScanner();
    expect(stdout).toContain('no secret-shaped strings found');
    expect(code).toBe(0);
  });

  it('detects an OpenAI-style key', () => {
    withPlanted({ 'a.env': 'OPENAI_API_KEY=sk-proj-Ab3xK9mQ7pL2nR5tY8uZ1vB4cD6fG0hJ3kM' }, () => {
      const { code, stderr } = runScanner();
      expect(code).toBe(1);
      expect(stderr).toContain('OpenAI-style key');
    });
  });

  it('detects a GitHub token', () => {
    withPlanted({ 'b.py': 'GITHUB_TOKEN = "ghp_0123456789abcdefghij0123456789abcd"' }, () => {
      expect(runScanner().stderr).toContain('GitHub token');
    });
  });

  it('detects an AWS access key id', () => {
    withPlanted({ 'c.txt': 'key AKIAIOSFODNN7EXAMPLE here' }, () => {
      expect(runScanner().stderr).toContain('AWS access key id');
    });
  });

  it('detects a Slack token', () => {
    withPlanted({ 'd.js': 'const t = "xoxb-123456789012-abcdefghijkl";' }, () => {
      expect(runScanner().stderr).toContain('Slack token');
    });
  });

  it('detects a private key header', () => {
    withPlanted({ 'e.pem': '-----BEGIN RSA PRIVATE KEY-----\n' }, () => {
      expect(runScanner().stderr).toContain('PEM private key');
    });
  });

  it('detects a high-entropy assignment with no vendor format', () => {
    withPlanted({ 'f.env': 'DB_PASSWORD=x7Kp2mQ9vR4tZ8nL3wY6bH1cD5' }, () => {
      const { code, stderr } = runScanner();
      expect(code).toBe(1);
      expect(stderr).toContain('DB_PASSWORD');
    });
  });

  /**
   * WHY this matters enough to pin: the scanner deliberately never prints a matched value, so a live
   * secret is not copied into CI logs. Asserting it here stops someone "fixing" a detection test
   * later by echoing the value to make debugging easier.
   */
  it('never echoes a matched secret value', () => {
    const secret = 'sk-proj-Ab3xK9mQ7pL2nR5tY8uZ1vB4cD6fG0hJ3kM';
    withPlanted({ 'g.env': `OPENAI_API_KEY=${secret}` }, () => {
      const { stderr } = runScanner();
      expect(stderr).not.toContain(secret);
      expect(stderr).toContain('OpenAI-style key');
    });
  });

  it('ignores placeholders and documentation', () => {
    withPlanted({
      'h.env': [
        'OPENAI_API_KEY=',
        'API_KEY=your-key-here',
        'SECRET=changeme',
        '# TOKEN=<your-token>',
        'PASSWORD=${PASSWORD}',
        'MY_KEY=process.env.SOMETHING',
      ].join('\n'),
    }, () => {
      const { code, stdout } = runScanner();
      expect(code).toBe(0);
      expect(stdout).toContain('no secret-shaped strings found');
    });
  });

  it('does not flag prose or code expressions that merely mention a key name', () => {
    withPlanted({
      'i.py': [
        '# KEY=value with comments and optional quotes.',
        'KEY = "placeholder"',
        '_TOKEN_RE = "some-regular-expression-pattern"',
        'KEYWORDS = "a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p"',
      ].join('\n'),
    }, () => {
      expect(runScanner().code).toBe(0);
    });
  });

  it('honours an inline allow marker', () => {
    withPlanted({ 'j.py': 'FAKE = "x7Kp2mQ9vR4tZ8nL3wY6bH1cD5"  # secret-scan: allow (fixture)' }, () => {
      expect(runScanner().code).toBe(0);
    });
  });

  it('never reads .env', () => {
    // WHY: AGENTS.md rule 6 forbids reading .env, and the scanner must not break the rule it exists
    // to enforce. A secret planted in a real .env must stay invisible to the scan.
    withPlanted({ '.env': 'OPENAI_API_KEY=sk-proj-Ab3xK9mQ7pL2nR5tY8uZ1vB4cD6fG0hJ3kM' }, () => {
      expect(runScanner().code).toBe(0);
    });
  });

  it('skips binary files', () => {
    withPlanted({ 'blob.pdf': 'sk-proj-Ab3xK9mQ7pL2nR5tY8uZ1vB4cD6fG0hJ3kM' }, () => {
      expect(runScanner().code).toBe(0);
    });
  });
});

describe.sequential('env drift check', () => {
  it('passes on the real .env.example', () => {
    expect(execFileSync('node', [DRIFT], { cwd: ROOT, encoding: 'utf8' })).toContain('env-drift: OK');
  });

  it('reports a variable that is documented but never read', () => {
    // WHY mutate the real file: the contract is "documented implies read", and the only honest way
    // to prove the check fails is to introduce a violation and observe the non-zero exit.
    withMutatedEnvExample('CANARY_UNREAD_VARIABLE=abc', () => {
      const r = spawnSync('node', [DRIFT], { cwd: ROOT, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('CANARY_UNREAD_VARIABLE');
    });
  });

  it('does not let a reasonless marker exempt a variable', () => {
    withMutatedEnvExample('# env-drift: planned\nCANARY_BARE_MARKER=abc', () => {
      const r = spawnSync('node', [DRIFT], { cwd: ROOT, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('CANARY_BARE_MARKER');
    });
  });

  it('accepts a planned marker that carries a reason', () => {
    withMutatedEnvExample('# env-drift: planned  (adapter lands in a later phase)\nCANARY_MARKED=abc', () => {
      expect(spawnSync('node', [DRIFT], { cwd: ROOT, encoding: 'utf8' }).status).toBe(0);
    });
  });
});

describe.sequential('task runner', () => {
  it('lists every implemented task and reports none as unimplemented', () => {
    // WHY the assertion flipped: this test used to require the "NOT implemented yet" section to be
    // present, which meant at least one task was unwritten. Every declared task is now implemented,
    // so requiring an unimplemented task would force the suite to fail forever. What actually
    // matters is that --list enumerates the tasks and that none of them claims to be missing.
    const out = execFileSync('node', [RUN, '--list'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('verify:fast');
    expect(out).toContain('verify');
    expect(out).toContain('test:e2e');
    expect(out).toContain('test:integration');
    expect(out).not.toContain('NOT implemented yet');
  });

  it('every npm script that delegates to the runner names a task that exists', () => {
    // WHY this replaces the old "an unimplemented task fails" test: with NOT_YET empty there is no
    // unimplemented task left to invoke, and the mechanism can no longer be exercised end to end.
    // This keeps the guarantee that actually protects users -- a script in package.json can never
    // point at a task the runner does not know, which would fail with "unknown task" at runtime.
    const source = readFileSync(RUN, 'utf8');
    // WHY read package.json here rather than import a shared constant: PKG is not defined in this
    // file (it lives in the tooling-contract section, which is a different scope).
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const declared = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.includes('scripts/run.mjs'))
      .map(([, cmd]) => /scripts\/run\.mjs\s+(\S+)/.exec(cmd)?.[1])
      .filter(Boolean);

    expect(declared.length).toBeGreaterThan(5);
    for (const task of declared) {
      // Group tasks (verify, verify:fast) are declared with `group:` rather than `cmd:`, so match
      // either form rather than assuming every task has a command.
      const defined = new RegExp(`['"]?${task.replace(':', '\\:')}['"]?:\\s*\\{`).test(source);
      expect(defined, `npm script references task "${task}" but run.mjs does not define it`).toBe(true);
    }
  });

  it('fails for an unknown task rather than doing nothing', () => {
    const r = spawnSync('node', [RUN, 'no-such-task'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown task');
  });

  it('runs the content validation task successfully', () => {
    expect(spawnSync('node', [RUN, 'validate:content'], { cwd: ROOT, encoding: 'utf8' }).status).toBe(0);
  });
});