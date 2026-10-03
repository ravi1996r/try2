/**
 * The Master bot's action vocabulary: shared validation for the browser and the gateway.
 *
 * WHY this is a security boundary and not a convenience: `tool_call` events arrive from a language
 * model, so they are UNTRUSTED INPUT that will change what a visitor sees. A model that emits
 * `set_font_size: 4.2` or an arbitrary font must not be able to make the page unreadable. Every
 * action is checked against a fixed allowlist with hard accessibility clamps, and an action that
 * fails validation is DROPPED with a reason rather than partially applied.
 *
 * WHY the browser validates even though the gateway does: the gateway is defence in depth, but the
 * browser-direct path (`path: "browser"`) lets a visitor's own key reach a provider without this
 * project's gateway. The page is the last gate, so it must not trust the event.
 *
 * WHY no schema library: this ships in the browser bundle, and Ajv would add weight to the hero JS
 * for a fixed, small vocabulary. Explicit rules are auditable, which matters more here than
 * generality. packages/contracts/schemas/master-action.schema.json stays normative; the drift tests
 * keep the two in agreement.
 *
 * ALTERNATIVES: (a) trust the model, (b) validate only server-side, (c) allow any CSS custom property.
 * WHY NOT: (a) hands an LLM control of accessibility settings; (b) leaves the browser path unguarded;
 * (c) is arbitrary control of the visitor's screen.
 */
import { ACTION_NAMES, FONT_ALLOWLIST, FONT_SCALE_MIN, FONT_SCALE_MAX, MOTION_MODES, QUALITY_TIERS, THEME_NAMES } from './index.js';

/** Scroll targets. A closed list keeps the bot from scrolling to arbitrary selectors. */
export const SCROLL_SECTIONS = Object.freeze([
  'hero', 'about', 'experience', 'projects', 'skills', 'education', 'achievements', 'contact',
]);

/** Accessibility bounds. The bot may enlarge text freely but may never shrink it below legibility. */
export const FONT_SCALE_FLOOR = FONT_SCALE_MIN;
export const FONT_SCALE_CEILING = FONT_SCALE_MAX;

const NAMES = new Set(ACTION_NAMES);
const THEMES = new Set(THEME_NAMES);
const FONTS = new Set(FONT_ALLOWLIST);
const SECTIONS = new Set(SCROLL_SECTIONS);
const BOTS = new Set(['bot1', 'bot2', 'bot3']);
const MOTION = new Set(MOTION_MODES);
const TIERS = new Set(QUALITY_TIERS);
const LAYOUTS = new Set(['grid', 'list', 'focus']);

/**
 * Actions whose entire effect is "no arguments". Listing them explicitly means an action added to
 * ACTION_NAMES without a rule here is REJECTED, not accepted with arbitrary args.
 */
export const NO_ARG_ACTIONS = Object.freeze(['reset_ui', 'undo', 'redo', 'open_model_settings']);

const err = (reason) => ({ ok: false, reason });

/** Booleans must be real booleans. A truthy string is refused: "false" is not false. */
function checkBoolean(v) {
  return typeof v === 'boolean' ? null : 'must be a boolean';
}

/** Finite only. NaN and Infinity are the classic way to slip a broken value past a clamp. */
function checkFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a finite number';
}

const inRange = (v, min, max) => (v >= min && v <= max ? null : `must be between ${min} and ${max}`);

function enumOf(value, set, label) {
  return typeof value === 'string' && set.has(value) ? null : `${label} must be one of: ${[...set].join(', ')}`;
}

/** Accepts only the listed keys, so an action cannot carry an ignored payload. */
function only(o, allowed) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unexpected argument "${k}"`;
  return null;
}

/**
 * Validates and clamps one action. Never throws: a malformed action from a model is an expected
 * condition, not an exceptional one, and it must never be able to break the render loop.
 *
 * @param {unknown} raw
 * @returns {{ok: true, action: {name: string, args: object}} | {ok: false, reason: string}}
 */
export function validateAction(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return err('action must be an object');
  const a = raw;

  if (typeof a.name !== 'string') return err('action.name must be a string');
  const name = a.name;
  if (!NAMES.has(name)) return err(`unknown action "${name}"`);

  // WHY reject unknown top-level keys: an action is an allowlisted command, not a bag of options.
  // Extra keys would be somewhere to smuggle data the dispatchers never inspect.
  for (const k of Object.keys(a)) {
    if (k !== 'name' && k !== 'args') return err(`unexpected property "${k}"`);
  }

  if (NO_ARG_ACTIONS.includes(name)) {
    if (a.args !== undefined) return err(`${name} takes no arguments`);
    return { ok: true, action: { name, args: {} } };
  }

  if (a.args === null || typeof a.args !== 'object' || Array.isArray(a.args)) return err(`${name}.args must be an object`);
  const o = a.args;

  const build = (allowed, arg) => {
    const bad = only(o, allowed);
    if (bad) return err(bad);
    return { ok: true, action: { name, args: arg } };
  };

  switch (name) {
    case 'set_theme': {
      const bad = enumOf(o.theme, THEMES, 'theme');
      return bad ? err(bad) : build(['theme'], { theme: o.theme });
    }
    case 'set_font': {
      // WHY an allowlist rather than "any installed font": a font the visitor lacks renders as a
      // fallback, so the bot could silently change typography while appearing to have obeyed.
      const bad = enumOf(o.font, FONTS, 'font');
      return bad ? err(bad) : build(['font'], { font: o.font });
    }
    case 'set_font_size': {
      // WHY clamped rather than rejected: a visitor asking for bigger text through conversation is an
      // accessibility feature, not an attack. Out-of-range values are pulled to the nearest legal
      // bound so the intent survives while the page stays legible.
      if (checkFinite(o.scale) === null) {
        const clamped = Math.min(FONT_SCALE_CEILING, Math.max(FONT_SCALE_FLOOR, o.scale));
        return build(['scale'], { scale: clamped });
      }
      const bad = checkFinite(o.scale);
      return bad ? err(`${name}.scale ${bad}`) : build(['scale'], { scale: o.scale });
    }
    case 'set_accent': {
      const bad = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color)
        ? null : 'color must be a 6-digit hex string';
      return bad ? err(bad) : build(['color'], { color: o.color });
    }
    case 'toggle_motion': {
      const bad = enumOf(o.mode, MOTION, 'mode');
      return bad ? err(bad) : build(['mode'], { mode: o.mode });
    }
    case 'set_quality': {
      const bad = enumOf(o.tier, TIERS, 'tier');
      return bad ? err(bad) : build(['tier'], { tier: o.tier });
    }
    case 'set_camera_preset': {
      const bad = typeof o.preset === 'string' && /^[a-z0-9_-]{1,64}$/.test(o.preset)
        ? null : 'preset must match ^[a-z0-9_-]{1,64}$';
      return bad ? err(bad) : build(['preset'], { preset: o.preset });
    }
    case 'scroll_to_section': {
      const bad = enumOf(o.section, SECTIONS, 'section');
      return bad ? err(bad) : build(['section'], { section: o.section });
    }
    case 'open_chatbot': {
      const bad = enumOf(o.bot, BOTS, 'bot');
      return bad ? err(bad) : build(['bot'], { bot: o.bot });
    }
    case 'close_chatbot': {
      if (o.bot === undefined) return build([], {});
      const bad = enumOf(o.bot, BOTS, 'bot');
      return bad ? err(bad) : build(['bot'], { bot: o.bot });
    }
    case 'set_layout': {
      const bad = enumOf(o.layout, LAYOUTS, 'layout');
      return bad ? err(bad) : build(['layout'], { layout: o.layout });
    }
    case 'toggle_sound': {
      const bad = checkBoolean(o.on);
      return bad ? err(`on ${bad}`) : build(['on'], { on: o.on });
    }
    case 'set_volume': {
      const bad = checkFinite(o.volume) ?? inRange(o.volume, 0, 1);
      return bad ? err(`volume ${bad}`) : build(['volume'], { volume: o.volume });
    }
    case 'toggle_high_contrast': {
      const bad = checkBoolean(o.on);
      return bad ? err(`on ${bad}`) : build(['on'], { on: o.on });
    }
    case 'toggle_dyslexia_friendly_font': {
      const bad = checkBoolean(o.on);
      return bad ? err(`on ${bad}`) : build(['on'], { on: o.on });
    }
    default:
      // WHY reachable in principle only: ACTION_NAMES and this switch must agree. A name added to the
      // allowlist without a rule is refused, which is the safe default for a security boundary.
      return err(`action "${name}" has no validator`);
  }
}

/**
 * Validates a list, keeping valid entries and reporting every rejection.
 *
 * WHY one bad action must not discard the good ones: a model emitting ten actions where one is
 * malformed should still deliver the other nine. Dropping the batch would be an invisible,
 * unfixable denial of service.
 *
 * @param {unknown} raw
 * @returns {{applied: Array<{name: string, args: object}>, rejected: Array<{reason: string}>}}
 */
export function validateActions(raw) {
  if (!Array.isArray(raw)) return { applied: [], rejected: [{ reason: 'expected an array of actions' }] };
  const applied = [];
  const rejected = [];
  for (const item of raw) {
    const r = validateAction(item);
    if (r.ok) applied.push(r.action);
    else rejected.push({ reason: r.reason });
  }
  return { applied, rejected };
}