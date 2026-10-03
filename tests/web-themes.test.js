import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * WHY this file parses source instead of importing the hook: the unit config globs `*.test.js` only,
 * and importing a `.ts` module would mean widening that glob to cover React + TSX, which would drag
 * the Playwright specs in with it (they are `.spec.ts` under the same `tests/` tree). Reading the two
 * declarations as text keeps this a fast, dependency-free contract test.
 *
 * WHY it exists: during the frontend work the theme list was defined TWICE -- once in the gateway's
 * /v1/config response and once in the browser hook -- with DIFFERENT names. Nothing failed. The page
 * simply offered themes that had no CSS behind them. This test makes that drift impossible.
 */
describe('theme single source of truth', () => {
  /** Pulls `THEMES` ids out of the hook source. */
  function hookThemeIds() {
    const src = read('apps', 'web', 'src', 'hooks', 'useTheme.ts');
    const block = /export const THEMES = \[([\s\S]*?)\] as const;/.exec(src);
    expect(block, 'could not find the THEMES array in useTheme.ts').not.toBeNull();
    return [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  }

  function gatewayThemeIds() {
    const src = read('services', 'gateway', 'src', 'app.js');
    const block = /themes:\s*\[([^\]]+)\]/.exec(src);
    expect(block, 'could not find the themes array in the gateway').not.toBeNull();
    return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it('the browser theme ids match the gateway /v1/config themes array exactly', () => {
    const fromGateway = gatewayThemeIds();
    expect(fromGateway.length).toBeGreaterThan(0);
    expect(hookThemeIds()).toEqual(fromGateway);
  });

  it('every theme has a CSS palette declaring all six tokens', () => {
    const css = read('apps', 'web', 'src', 'index.css');
    const tokens = ['--bg', '--fg', '--muted', '--card', '--line', '--accent'];
    for (const id of hookThemeIds()) {
      // WHY per-theme and all six: a theme overriding only --accent would inherit the base
      // background, so the axe contrast check would then have to be re-verified for every accidental
      // combination rather than once per theme.
      const block = new RegExp(`\\[data-theme='${id}'\\]\\s*\\{([^}]*)\\}`).exec(css);
      expect(block, `theme "${id}" has no CSS block`).not.toBeNull();
      for (const token of tokens) {
        expect(block[1], `theme "${id}" does not set ${token}`).toContain(`${token}:`);
      }
    }
  });

  it('the hook default theme is the first entry and has a CSS block', () => {
    const css = read('apps', 'web', 'src', 'index.css');
    const src = read('apps', 'web', 'src', 'hooks', 'useTheme.ts');
    const first = hookThemeIds()[0];
    const declaredDefault = /DEFAULT_THEME:\s*ThemeId\s*=\s*'([^']+)'/.exec(src);
    expect(declaredDefault, 'DEFAULT_THEME is not declared').not.toBeNull();
    // WHY assert the pairing: a default with no CSS block means the page renders in whatever site.css
    // supplies until React hydrates, which reads as a visible flash of the wrong palette.
    expect(declaredDefault[1]).toBe(first);
    expect(css).toContain(`[data-theme='${first}']`);
  });
});