/**
 * The Master action validator is the boundary between untrusted model output and a visitor's screen.
 *
 * WHY these tests are mostly negative: the interesting cases are the ones a language model can produce
 * by accident, by over-eagerness, or by following an instruction inside a document it read. Each test
 * below corresponds to a specific way that could lock a visitor out of the page or smuggle data past
 * the dispatchers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateAction, validateActions, NO_ARG_ACTIONS, SCROLL_SECTIONS } from '../src/actions.js';
import { ACTION_NAMES, FONT_SCALE_MIN, FONT_SCALE_MAX } from '../src/index.js';

describe('master actions: the vocabulary is closed', () => {
  it('refuses an action outside the allowlist', () => {
    // WHY this matters most: a model that could name any action could name one that fetches a URL or
    // reads storage. The allowlist IS the boundary.
    const r = validateAction({ name: 'evaluate_javascript', args: { code: 'stealCookies()' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown action/);
  });

  it('gives every allowlisted name a validator, so none can reach dispatch unreviewed', () => {
    // WHY: a name added to ACTION_NAMES without a matching rule in the switch must fail CLOSED. This
    // asserts the two lists agree, which is what keeps the switch from growing a silent gap.
    const validatorSource = readFileSync(fileURLToPath(new URL('../src/actions.js', import.meta.url)), 'utf8');
    const missing = ACTION_NAMES.filter(
      (n) => !validatorSource.includes(`case '${n}':`) && !NO_ARG_ACTIONS.includes(n),
    );
    expect(missing, `no validator for: ${missing.join(', ')}`).toEqual([]);
  });

  it('rejects unexpected top-level properties', () => {
    // WHY: an action is an allowlisted command, not a bag of options. Extra keys are a place to carry
    // data the dispatchers never inspect.
    const r = validateAction({ name: 'set_theme', args: { theme: 'chill' }, html: '<script>' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unexpected property/);
  });

  it('rejects an argument that is not in the action\'s own list', () => {
    const r = validateAction({ name: 'set_theme', args: { theme: 'chill', sneaky: 1 } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unexpected argument/);
  });

  it('refuses no-argument actions that arrive with arguments', () => {
    for (const name of NO_ARG_ACTIONS) {
      expect(validateAction({ name, args: { x: 1 } }).ok, `${name} accepted args`).toBe(false);
    }
  });
});

describe('master actions: accessibility cannot be taken away', () => {
  it('clamps font size to the legal band instead of trusting the model', () => {
    // WHY clamp rather than reject: a visitor asking for bigger text through conversation is an
    // accessibility feature. Rejecting it would make the bot unable to help the people who need it.
    const huge = validateAction({ name: 'set_font_size', args: { scale: 40 } });
    expect(huge.ok).toBe(true);
    expect(huge.action.args.scale).toBe(FONT_SCALE_MAX);

    const tiny = validateAction({ name: 'set_font_size', args: { scale: 0.01 } });
    expect(tiny.ok).toBe(true);
    expect(tiny.action.args.scale).toBe(FONT_SCALE_MIN);
  });

  it('never lets font size fall below the legibility floor', () => {
    for (const scale of [-5, 0, 0.1, FONT_SCALE_MIN - 0.01]) {
      const r = validateAction({ name: 'set_font_size', args: { scale } });
      expect(r.ok).toBe(true);
      expect(r.action.args.scale, `scale ${scale} escaped the floor`).toBeGreaterThanOrEqual(FONT_SCALE_MIN);
    }
  });

  it('refuses NaN and Infinity, which would defeat a naive range check', () => {
    // WHY: `x >= min && x <= max` is FALSE for NaN, but clamps written as Math.min/Math.max turn NaN
    // into a number. The validator must reject rather than launder it.
    expect(validateAction({ name: 'set_font_size', args: { scale: NaN } }).ok).toBe(false);
    expect(validateAction({ name: 'set_volume', args: { volume: Infinity } }).ok).toBe(false);
    expect(validateAction({ name: 'set_volume', args: { volume: NaN } }).ok).toBe(false);
  });

  it('restricts fonts to the licensed allowlist', () => {
    expect(validateAction({ name: 'set_font', args: { font: 'Comic Sans MS' } }).ok).toBe(false);
    expect(validateAction({ name: 'set_font', args: { font: 'Atkinson Hyperlegible' } }).ok).toBe(true);
  });

  it('restricts accents to hex so nothing can be injected as a CSS value', () => {
    expect(validateAction({ name: 'set_accent', args: { color: 'red' } }).ok).toBe(false);
    expect(validateAction({ name: 'set_accent', args: { color: 'url(https://evil.example/x)' } }).ok).toBe(false);
    expect(validateAction({ name: 'set_accent', args: { color: '#ff8800' } }).ok).toBe(true);
  });
});

describe('master actions: booleans must be booleans', () => {
  it('refuses the string "false", which is truthy in JavaScript', () => {
    // WHY: the model emits JSON, and a string "false" is a classic generation slip. Treated as truthy
    // it would enable sound or high contrast when the model meant to disable them.
    for (const name of ['toggle_sound', 'toggle_high_contrast', 'toggle_dyslexia_friendly_font']) {
      const r = validateAction({ name, args: { on: 'false' } });
      expect(r.ok, `${name} accepted the string "false"`).toBe(false);
      expect(r.reason).toMatch(/boolean/);
    }
  });
});
describe('master actions: volume and ranges', () => {
  it('keeps volume inside 0..1', () => {
    expect(validateAction({ name: 'set_volume', args: { volume: 2 } }).ok).toBe(false);
    expect(validateAction({ name: 'set_volume', args: { volume: -1 } }).ok).toBe(false);
    expect(validateAction({ name: 'set_volume', args: { volume: 0.5 } }).action.args.volume).toBe(0.5);
  });

  it('restricts camera presets to a safe character set', () => {
    // WHY: a preset name reaches a camera lookup. A restricted charset means it can never be used to
    // traverse a path or escape a selector.
    expect(validateAction({ name: 'set_camera_preset', args: { preset: '../../etc/passwd' } }).ok).toBe(false);
    // WHY lowercase: master-action.schema.json declares ^[a-z0-9_-]+$ and that schema is normative.
    // This test originally used "Front_View-01" and failed -- the TEST was wrong, not the validator,
    // which correctly refuses a preset the schema does not permit.
    expect(validateAction({ name: 'set_camera_preset', args: { preset: 'front_view-01' } }).ok).toBe(true);
    expect(validateAction({ name: 'set_camera_preset', args: { preset: 'Front_View-01' } }).ok).toBe(false);
  });

  it('restricts scrolling to real sections', () => {
    for (const section of SCROLL_SECTIONS) {
      expect(validateAction({ name: 'scroll_to_section', args: { section } }).ok, section).toBe(true);
    }
    expect(validateAction({ name: 'scroll_to_section', args: { section: 'admin' } }).ok).toBe(false);
  });
});

describe('master actions: one bad action must not lose the good ones', () => {
  it('keeps valid actions and reports rejections separately', () => {
    // WHY: a model emitting ten actions where one is malformed should still deliver nine. Dropping the
    // batch would be a denial of service the visitor can neither see nor fix.
    const { applied, rejected } = validateActions([
      { name: 'set_theme', args: { theme: 'retro' } },
      { name: 'set_font_size', args: { scale: 999 } },
      { name: 'delete_everything' },
      { name: 'scroll_to_section', args: { section: 'contact' } },
    ]);
    expect(applied.map((a) => a.name)).toEqual(['set_theme', 'set_font_size', 'scroll_to_section']);
    expect(applied[1].args.scale).toBe(FONT_SCALE_MAX);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/unknown action/);
  });

  it('never throws on hostile input', () => {
    // WHY: validateAction runs inside the SSE handler. An exception there would kill the stream, so a
    // model emitting `null` must produce a rejection, not a crash.
    for (const hostile of [null, undefined, 42, 'set_theme', [], NaN, { name: null }]) {
      expect(() => validateAction(hostile)).not.toThrow();
      expect(validateAction(hostile).ok).toBe(false);
    }
  });
});