/**
 * Themes are DATA now, so they can be tested as data.
 *
 * WHY this suite is mostly about failure: the interesting bugs are a theme that ships incomplete -- a
 * palette with no scene config, a preset the Master bot cannot legally name, a contrast ratio two points
 * below AA. All of those type-check perfectly, which is exactly why a runtime validator run against
 * every theme is the only thing that catches them.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME,
  MIN_BODY_CONTRAST,
  THEME_IDS,
  THEME_REGISTRY,
  contrastRatio,
  getTheme,
  validateAllThemes,
  validateTheme,
} from '../src/scene/themes';

describe('theme registry: every theme is complete and safe', () => {
  it('passes validation with zero problems', () => {
    // WHY this is the headline assertion: a non-empty list means a theme cannot ship.
    expect(validateAllThemes()).toEqual([]);
  });

  it('validates each theme independently so a failure names the theme', () => {
    for (const id of THEME_IDS) {
      expect(validateTheme(THEME_REGISTRY[id]), `${id} failed validation`).toEqual([]);
    }
  });
});

describe('theme registry: accessibility cannot be configured away', () => {
  it('every theme clears the AA body-text contrast floor', () => {
    // WHY the most important test in the file: a visitor switching theme must not end up unable to read
    // the page. That is a cosmetic choice producing a functional lockout.
    for (const id of THEME_IDS) {
      const t = THEME_REGISTRY[id];
      expect(contrastRatio(t.palette.text, t.palette.bg), `${id} contrast`)
        .toBeGreaterThanOrEqual(MIN_BODY_CONTRAST);
    }
  });

  it('the stored contrast ratio matches the computed one, so it cannot be a stale claim', () => {
    // WHY: the UI may display this number. A stored value that no longer matches the palette is a false
    // claim, and a 0.2 tolerance catches a hand-edited number.
    for (const id of THEME_IDS) {
      const t = THEME_REGISTRY[id];
      const computed = contrastRatio(t.palette.text, t.palette.bg);
      expect(Math.abs(computed - t.bodyContrast), `${id} stored contrast`).toBeLessThanOrEqual(0.2);
    }
  });

  it('the accent is distinguishable from the background on every theme', () => {
    // WHY: an accent the same colour as the page is an invisible control. 1.6 is well below AA for text,
    // because an accent is usually a border or fill rather than body copy -- but it must still be visible.
    for (const id of THEME_IDS) {
      const t = THEME_REGISTRY[id];
      expect(contrastRatio(t.palette.accent, t.palette.bg), id).toBeGreaterThan(1.6);
    }
  });
});

describe('theme registry: the Master bot can legally reach every theme', () => {
  it('uses only fonts the action validator allowlists', () => {
    // WHY: the bot can call set_font, and set_theme picks a font. A theme using a font outside the
    // allowlist would leave a visitor unable to switch BACK, because the bot would refuse to name it.
    const allowlist = [
      'Inter', 'JetBrains Mono', 'Space Grotesk', 'IBM Plex Sans', 'IBM Plex Mono',
      'Source Sans 3', 'Sora', 'Bitter', 'Nunito Sans', 'Atkinson Hyperlegible',
    ];
    for (const id of THEME_IDS) {
      expect(allowlist, `${id} font`).toContain(THEME_REGISTRY[id].font);
    }
  });

  it('names every camera preset the bot is allowed to request', () => {
describe('theme validator: it refuses an incomplete theme', () => {
  const base = THEME_REGISTRY.chill;

  it('rejects a palette that is not hex', () => {
    expect(validateTheme({ ...base, palette: { ...base.palette, bg: 'black' } }).join()).toMatch(/hex/);
  });

  it('rejects body text below the AA floor', () => {
    // WHY the ratio is corrected too: if only the colour changed, the mismatch test would fire first and
    // mask the contrast assertion. Both must be wrong together to isolate the failure.
    const bad = { ...base, palette: { ...base.palette, text: '#2a2a2a', bg: '#1a1a1a' }, bodyContrast: 1.2 };
    expect(validateTheme(bad).join()).toMatch(/contrast/i);
  });

  it('rejects a defaultPreset that is not defined', () => {
    const scene = { ...base.scene, defaultPreset: 'nope' };
    expect(validateTheme({ ...base, scene }).join()).toMatch(/defaultPreset/);
  });

  it('rejects a camera further away than anything could render', () => {
    const scene = {
      ...base.scene,
      cameraPresets: { far: { x: 500, y: 0, z: 0 } },
      defaultPreset: 'far',
    };
    expect(validateTheme({ ...base, scene }).join()).toMatch(/40 units/);
  });

  it('rejects a font outside the licensed allowlist', () => {
    expect(validateTheme({ ...base, font: 'Comic Sans MS' }).join()).toMatch(/allowlist/);
  });

  it('rejects an opacity outside 0..1', () => {
    expect(validateTheme({ ...base, scene: { ...base.scene, opacity: 1.4 } }).join()).toMatch(/opacity/);
  });

  it('rejects a detail level the geometry cannot honour', () => {
    expect(validateTheme({ ...base, scene: { ...base.scene, detail: 99 } }).join()).toMatch(/detail/);
  });
});

describe('theme registry: the ids and the registry agree', () => {
  it('has no id in one list and not the other', () => {
    // WHY both directions: an id missing from the registry crashes on render, and a registry entry not
    // in THEME_IDS is unreachable dead code that still ships in the bundle.
    const declared = new Set(THEME_IDS);
    const registered = new Set(Object.keys(THEME_REGISTRY));
    expect([...registered].filter((k) => !declared.has(k))).toEqual([]);
    expect([...declared].filter((k) => !registered.has(k))).toEqual([]);
  });

  it('exposes five themes, matching what the gateway advertises', () => {
    // WHY the count is asserted: /v1/config advertises this list. A theme added only on one side would
    // make the UI offer a theme the server has never heard of.
    expect(THEME_IDS).toHaveLength(5);
  });
});

describe('getTheme: never returns undefined', () => {
  it('falls back to the default for an unknown id', () => {
    // WHY: a stale localStorage value or hand-edited URL must not crash. The page has to render.
    expect(getTheme('does-not-exist').id).toBe(DEFAULT_THEME);
    expect(getTheme(null).id).toBe(DEFAULT_THEME);
    expect(getTheme(undefined).id).toBe(DEFAULT_THEME);
  });

  it('returns the requested theme when it is real', () => {
    expect(getTheme('cyberpunk').id).toBe('cyberpunk');
  });
});

describe('contrastRatio: the maths is right', () => {
  it('returns 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('returns 1 for a colour against itself', () => {
    expect(contrastRatio('#58a6ff', '#58a6ff')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(contrastRatio('#abcdef', '#123456'), 6);
  });
});
    // WHY: set_camera_preset enforces ^[a-z0-9_-]+$. A preset outside that charset would be unreachable
    // by design -- dead data that looks like a feature.
    for (const id of THEME_IDS) {
      for (const name of Object.keys(THEME_REGISTRY[id].scene.cameraPresets)) {
        expect(name, `${id} preset ${name}`).toMatch(/^[a-z0-9_-]{1,64}$/);
      }
    }
  });

  it('defaults to a preset that actually exists', () => {
    // WHY: a missing default leaves the camera wherever the constructor put it, so the theme looks wrong
    // with no indication that a string was misspelled.
    for (const id of THEME_IDS) {
      const scene = THEME_REGISTRY[id].scene;
      expect(Object.keys(scene.cameraPresets), id).toContain(scene.defaultPreset);
    }
  });
});