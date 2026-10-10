/**
 * Themes as DATA, not bespoke CSS.
 *
 * WHY this file exists: the five themes were five CSS blocks and one shared Three.js scene. Adding a
 * theme meant writing a new CSS selector AND a new branch in the scene, and there was no way to tell
 * whether a theme was complete -- a theme could ship with a palette and no scene config, and nothing
 * would complain until someone noticed the object looked the same on two different themes.
 *
 * So a theme is now a value: a palette, a scene description and an accessibility posture. Adding one is
 * adding one entry to `THEME_REGISTRY`, and `validateTheme()` proves the entry is complete before it is
 * used. That is what turns "themes" from five CSS files into data the browser can reason about.
 *
 * WHY `scene` is a description and not a Three.js object: a scene CONFIG must be serialisable and
 * inspectable. If the config were a live object, no test could assert that a theme defines a geometry,
 * and the lazy per-theme module loader could not decide which chunk to fetch. The description is the
 * contract; the module is the implementation.
 *
 * ALTERNATIVES: (a) keep CSS-only themes, (b) one scene that switches on a theme string.
 * WHY NOT: (a) is what this replaces -- it cannot express per-theme motion or geometry; (b) puts an
 * `if (theme === ...)` inside the render loop, which is exactly the pattern AGENTS.md forbids.
 */

/** Motion posture. `reduced` means the scene renders one static frame, never a loop. */
export type MotionMode = 'on' | 'off' | 'reduced';

/** Quality tiers. `auto` lets the runtime degrade on measured frame time (see perf-budget.ts). */
export type QualityTier = 'low' | 'medium' | 'high' | 'auto';

/**
 * What a scene looks like and how it moves.
 *
 * WHY every field has a WHY below it in the registry: these are the numbers a visitor experiences, and
 * a value changed without understanding what it costs shows up as a dropped frame on a phone.
 */
export interface SceneConfig {
  /** Which per-theme scene module builds this. Resolved to a lazy chunk by registry.ts. */
  kind: 'lattice' | 'vortex' | 'orb' | 'grid' | 'monolith';
  /** Subdivision detail. Bounded by quality tier at runtime. */
  detail: number;
  /** Rotation speed per axis, radians per frame at 60fps. */
  rotation: { x: number; y: number; z: number };
  /** Draw as wireframe rather than solid. Wireframe is cheaper and reads as "technical". */
  wireframe: boolean;
  /** Material opacity. Below 1 so the prerendered text stays legible behind the canvas. */
  opacity: number;
  /** Camera presets the Master bot may request. Keys are the values set_camera_preset accepts. */
  cameraPresets: Record<string, { x: number; y: number; z: number }>;
  /** Named camera positions, used by the default preset. */
  defaultPreset: string;
}

/** The full token set for one theme. */
export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  /** CSS custom-property palette applied to <html data-theme>. */
  palette: {
    bg: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentContrast: string;
    border: string;
  };
  scene: SceneConfig;
  /**
   * Motion posture. WHY it is part of the theme rather than a global setting: a theme's identity can BE
   * its stillness. A theme that animates aggressively contradicts a visitor who asked for reduced motion,
   * so the theme states its intent and the runtime takes the stricter of the two.
   */
  motion: MotionMode;
  /** Body font family. Must be in the FONT_ALLOWLIST the Master bot validates against. */
  font: string;
  /**
   * WCAG AA contrast ratio for body text against `bg`, precomputed.
   *
   * WHY stored rather than computed at runtime: it is a build-time property of two hex values, and
   * computing it on every render to assert something that cannot change is waste. A test asserts the
   * stored value matches the computed one, so it cannot drift.
   */
  bodyContrast: number;
}

export const THEME_IDS = ['chill', 'cyberpunk', 'fantasy', 'retro', 'modern'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'chill';

/**
 * The five themes. Adding one means adding an entry here and a scene module in `scenes/`.
 *
 * WHY the palettes are hex and not `oklch()`: a test computes WCAG contrast from them, and the
 * luminance maths is defined for sRGB. An oklch value would have to be converted first, and a contrast
 * check that silently skipped a theme because its colour space was unfamiliar is worse than no check.
 */
export const THEME_REGISTRY: Readonly<Record<ThemeId, ThemeDefinition>> = Object.freeze({
  chill: {
    id: 'chill',
    label: 'Chill',
    palette: {
      bg: '#0b1220', surface: '#131c2e', text: '#e6edf7', muted: '#9fb0c9',
      accent: '#58a6ff', accentContrast: '#04121f', border: '#22304a',
    },
    scene: {
      kind: 'orb',
      detail: 1,
      // WHY slow: this theme's identity is calm, and a fast-rotating object contradicts the name. It is
      // also the cheapest motion, which matters because `chill` is the DEFAULT and therefore the one a
      // visitor sees on a cold, unmeasured load.
      rotation: { x: 0.0016, y: 0.0022, z: 0.0009 },
      wireframe: true,
      opacity: 0.8,
      cameraPresets: {
        overview: { x: 0, y: 0, z: 4 },
        close: { x: 0, y: 0, z: 2.4 },
        low: { x: 0.2, y: -0.4, z: 3.4 },
      },
      defaultPreset: 'overview',
    },
    motion: 'on',
    font: 'Inter',
    bodyContrast: 15.9,
  },

  cyberpunk: {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    palette: {
      bg: '#07060d', surface: '#11101c', text: '#eaf6ff', muted: '#8b93b8',
      accent: '#ff2d95', accentContrast: '#12000a', border: '#2a1f3d',
    },
    scene: {
      kind: 'vortex',
      detail: 2,
      // WHY faster: the theme's whole identity is energy. Still expensive, so `detail` stays at 2 and the
      // low tier drops it rather than the motion, because motion is the point of this theme.
      rotation: { x: 0.0035, y: 0.0062, z: -0.0044 },
      wireframe: true,
      opacity: 0.72,
      cameraPresets: {
        overview: { x: 0, y: 0.3, z: 4.6 },
        close: { x: 0, y: 0, z: 2.2 },
        side: { x: 2.4, y: 0.2, z: 1.2 },
      },
      defaultPreset: 'overview',
    },
    motion: 'on',
    font: 'Space Grotesk',
    bodyContrast: 18.4,
  },

  fantasy: {
    id: 'fantasy',
    label: 'Fantasy',
    palette: {
      bg: '#100a1c', surface: '#1a1130', text: '#f3ecff', muted: '#b6a6d6',
      accent: '#a970ff', accentContrast: '#14032b', border: '#33224f',
    },
    scene: {
      kind: 'lattice',
      detail: 1,
      // WHY barely animated: this theme reads as ornate and still. A gentle drift is enough, and it keeps
      // the frame cost near the default rather than near cyberpunk.
      rotation: { x: 0.0011, y: 0.0018, z: 0.0006 },
      wireframe: true,
      opacity: 0.66,
      cameraPresets: {
        overview: { x: 0, y: 0, z: 4.2 },
        close: { x: 0.1, y: 0, z: 2.6 },
        above: { x: 0, y: 2.2, z: 1.8 },
      },
      defaultPreset: 'overview',
    },
    motion: 'reduced',
    font: 'Bitter',
    bodyContrast: 16.9,
  },

  retro: {
    id: 'retro',
    label: 'Retro',
    palette: {
      bg: '#1b1410', surface: '#261c16', text: '#f6ece0', muted: '#c0a892',
      accent: '#ff8c42', accentContrast: '#2a1000', border: '#3d2d22',
    },
    scene: {
      kind: 'grid',
      detail: 1,
      // WHY a grid and not a solid: this theme's reference is a wireframe horizon, so the geometry IS the
      // identity. It is also the cheapest scene to draw, which suits a theme whose palette is the dimmest.
      rotation: { x: 0.0009, y: 0.0024, z: 0 },
      wireframe: true,
      opacity: 0.55,
      cameraPresets: {
        overview: { x: 0, y: 0.6, z: 4.4 },
        close: { x: 0, y: 0, z: 2.8 },
        horizon: { x: 0, y: 1.4, z: 3 },
      },
      defaultPreset: 'overview',
    },
    motion: 'on',
    font: 'IBM Plex Mono',
    bodyContrast: 15.6,
  },

  modern: {
    id: 'modern',
    label: 'Modern',
    palette: {
      bg: '#0d1117', surface: '#161b22', text: '#f0f6fc', muted: '#a8b3c1',
      accent: '#3b82f6', accentContrast: '#03101f', border: '#252c38',
    },
    scene: {
      kind: 'monolith',
      detail: 1,
      // WHY the sharpest geometry and the least motion: this theme is meant to disappear behind the
      // content. It is the closest thing to "no scene", which is the right default for a portfolio whose
      // priority is the text.
      rotation: { x: 0.0007, y: 0.0013, z: 0 },
      wireframe: false,
      opacity: 0.42,
      cameraPresets: {
        overview: { x: 0, y: 0, z: 4.8 },
        close: { x: 0, y: 0, z: 3.2 },
        angle: { x: 0.9, y: 0.4, z: 3.6 },
      },
      defaultPreset: 'overview',
    },
    motion: 'on',
    font: 'IBM Plex Sans',
    bodyContrast: 17.4,
  },
});

/**
 * Relative luminance per WCAG 2.1. WHY it is reimplemented: the alternative is a dependency in the
 * browser bundle to compute one number from three integers, and the formula is three lines.
 */
export function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.1 contrast ratio between two hex colours. 1 is identical, 21 is black on white. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The AA floor for body text. Matches MIN_BODY_CONTRAST in packages/contracts. */
export const MIN_BODY_CONTRAST = 4.5;

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT_ALLOWLIST = new Set([
  'Inter', 'JetBrains Mono', 'Space Grotesk', 'IBM Plex Sans', 'IBM Plex Mono',
  'Source Sans 3', 'Sora', 'Bitter', 'Nunito Sans', 'Atkinson Hyperlegible',
]);

/**
 * Proves one theme is complete and safe before it is used.
 *
 * WHY this is a function and not just a type: the TypeScript interface proves a field EXISTS, not that
 * it is usable. `bodyContrast: 3.1` type-checks perfectly and is an accessibility failure, and
 * `defaultPreset: 'nope'` type-checks and would leave the camera where it was. This is the check that
 * catches both, and it runs in a test against every entry in the registry.
 *
 * @returns a list of problems. Empty means the theme is safe to use.
 */
export function validateTheme(theme: ThemeDefinition): string[] {
  const problems: string[] = [];
  const push = (msg: string) => problems.push(`${theme.id}: ${msg}`);

  for (const [name, value] of Object.entries(theme.palette)) {
    if (!HEX.test(value)) push(`palette.${name} is not a 6-digit hex colour (${value})`);
  }
  if (HEX.test(theme.palette.text) && HEX.test(theme.palette.bg)) {
    const ratio = contrastRatio(theme.palette.text, theme.palette.bg);
    // WHY the stored value is checked too: it is what the UI would report, so a stale stored number is a
    // false claim even when the palette itself is fine.
    if (Math.abs(ratio - theme.bodyContrast) > 0.2) {
      push(`bodyContrast says ${theme.bodyContrast} but the palette computes ${ratio.toFixed(2)}`);
    }
    // WHY this is the hard failure: an unreadable theme is worse than a missing one. A visitor who
    // switches theme and cannot read the page has been locked out by a cosmetic choice.
    if (ratio < MIN_BODY_CONTRAST) {
      push(`body text contrast ${ratio.toFixed(2)} is below the AA floor of ${MIN_BODY_CONTRAST}`);
    }
  }
  if (!HEX.test(theme.palette.accent)) push('palette.accent must be a hex colour');

  if (!FONT_ALLOWLIST.has(theme.font)) {
    // WHY the same allowlist the Master bot validates against: the bot can call set_font, and a theme
    // using a font outside that list could be switched TO and then not back, because the bot would
    // refuse to name it.
    push(`font "${theme.font}" is not in the licensed allowlist`);
  }

  const presets = theme.scene.cameraPresets;
  if (!theme.scene.defaultPreset || !(theme.scene.defaultPreset in presets)) {
    push(`scene.defaultPreset "${theme.scene.defaultPreset}" is not one of the defined presets`);
  }
  if (Object.keys(presets).length === 0) push('scene defines no camera presets');
  for (const [name, pos] of Object.entries(presets)) {
    // WHY the character set: a preset name reaches the Master bot and back through set_camera_preset,
    // which enforces ^[a-z0-9_-]+$. A theme defining anything else would offer a preset the bot cannot
    // legally request.
    if (!/^[a-z0-9_-]{1,64}$/.test(name)) push(`camera preset name "${name}" is not [a-z0-9_-]`);
    for (const axis of ['x', 'y', 'z'] as const) {
      if (!Number.isFinite(pos[axis])) push(`camera preset "${name}" has a non-finite ${axis}`);
    }
    if (Math.hypot(pos.x, pos.y, pos.z) > 40) {
      // WHY a bound: a camera that far out renders nothing, so the theme would look broken with no
      // indication that a number was wrong.
      push(`camera preset "${name}" is further than 40 units from the origin`);
    }
  }
  if (!(theme.scene.detail >= 0 && theme.scene.detail <= 4)) {
    push(`scene.detail ${theme.scene.detail} is outside 0..4`);
  }
  if (!(theme.scene.opacity > 0 && theme.scene.opacity <= 1)) {
    push(`scene.opacity ${theme.scene.opacity} is outside 0..1`);
  }

  return problems;
}

/** Validates every theme in the registry. A non-empty result means a theme cannot ship. */
export function validateAllThemes(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of THEME_IDS) {
    const theme = THEME_REGISTRY[id];
    if (!theme) {
      problems.push(`${id}: declared in THEME_IDS but missing from THEME_REGISTRY`);
      continue;
    }
    if (seen.has(theme.id)) problems.push(`${id}: duplicate id`);
    seen.add(theme.id);
    problems.push(...validateTheme(theme));
  }
  // WHY the reverse check: a registry entry not in THEME_IDS would be unreachable, because ThemeId is
  // derived from THEME_IDS. A theme nobody can select is dead code that still ships in the bundle.
  for (const id of Object.keys(THEME_REGISTRY)) {
    if (!(THEME_IDS as readonly string[]).includes(id)) {
      problems.push(`${id}: in THEME_REGISTRY but not in THEME_IDS, so it is unreachable`);
    }
  }
  return problems;
}

/** Reads a theme by id, falling back to the default. Never returns undefined. */
export function getTheme(id: string | undefined | null): ThemeDefinition {
  if (id && (THEME_IDS as readonly string[]).includes(id)) return THEME_REGISTRY[id as ThemeId];
  return THEME_REGISTRY[DEFAULT_THEME];
}
