/**
 * WHY: The Master action schema is long and highly regular (19 actions, each with its own arg
 * shape). Hand-maintaining a 200-line JSON file invites typos that a schema cannot catch.
 * ALTERNATIVES: (a) hand-write it, (b) build a Zod/JSON-schema validator in code and ship that,
 *   (c) generate the JSON Schema from a compact table, as done here.
 * WHY NOT: (a) drift risk; (b) then Python could not validate it without a second implementation,
 *   which is exactly the duplication this project is trying to avoid.
 * TRADE-OFF: the generated file is checked in (so no build step is needed to run tests) and this
 *   generator is the only thing allowed to write it. `npm run generate:contracts` regenerates.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'packages', 'contracts', 'schemas', 'master-action.schema.json');

const THEMES = ['chill', 'cyberpunk', 'fantasy', 'retro', 'modern'];
const FONTS = [
  'Inter', 'JetBrains Mono', 'Space Grotesk', 'IBM Plex Sans', 'IBM Plex Mono',
  'Source Sans 3', 'Sora', 'Bitter', 'Nunito Sans', 'Atkinson Hyperlegible',
];
const SECTIONS = [
  'hero', 'about', 'experience', 'projects', 'skills', 'education', 'achievements', 'contact',
];

const A = (props, required = []) => ({
  type: 'object',
  ...(required.length ? { required } : {}),
  properties: props,
  additionalProperties: false,
});

const S = (type, extra = {}) => ({ type, ...extra });
const E = (values) => ({ enum: values });

/** name -> { args: schema|null }  (null args means the action takes no arguments at all) */
const ACTIONS = {
  set_theme: { args: A({ theme: E(THEMES) }, ['theme']) },
  set_font: { args: A({ family: E(FONTS) }, ['family']) },
  // WHY: hard numeric floors live in the schema itself, so the AI service, the gateway and the
  // browser all reject font size 4.0 from the same rule instead of three slightly different ones.
  set_font_size: { args: A({ scale: S('number', { minimum: 0.85, maximum: 1.6 }) }, ['scale']) },
  set_accent: {
    args: A({ color: S('string', { pattern: '^#[0-9a-fA-F]{6}$' }) }, ['color']),
  },
  toggle_motion: { args: A({ mode: E(['on', 'off', 'reduced']) }, ['mode']) },
  set_quality: { args: A({ tier: E(['low', 'medium', 'high', 'auto']) }, ['tier']) },
  set_camera_preset: {
    args: A({ preset: S('string', { maxLength: 64, pattern: '^[a-z0-9_-]+$' }) }, ['preset']),
  },
  scroll_to_section: { args: A({ section: E(SECTIONS) }, ['section']) },
  open_chatbot: { args: A({ bot: E(['bot1', 'bot2', 'bot3']) }, ['bot']) },
  close_chatbot: { args: A({}) },
  set_layout: {
    args: A({
      position: E(['left', 'right', 'center']),
      size: E(['compact', 'default', 'large']),
      density: E(['comfortable', 'compact']),
    }),
  },
  toggle_sound: { args: A({ on: S('boolean') }, ['on']) },
  set_volume: { args: A({ volume: S('number', { minimum: 0, maximum: 1 }) }, ['volume']) },
  toggle_high_contrast: { args: A({ on: S('boolean') }, ['on']) },
  toggle_dyslexia_friendly_font: { args: A({ on: S('boolean') }, ['on']) },
  reset_ui: { args: null },
  undo: { args: null },
  redo: { args: null },
  // WHY: this action may only open the model panel. The schema has no field for a key, base URL
  // or model name, so the Master bot structurally cannot set them (requirement 4.4 / E2E-32).
  open_model_settings: { args: A({}) },
};

const allOf = Object.entries(ACTIONS).map(([name, def]) => {
  const base = { if: { properties: { name: { const: name } }, required: ['name'] } };
  if (def.args === null) {
    // No `then` beyond requiring the name: an action that takes no args must carry none.
    return { ...base, then: { required: ['name'] } };
  }
  return {
    ...base,
    then: { required: ['name', 'args'], properties: { args: def.args } },
  };
});

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://portfolio.local/schemas/master-action.schema.json',
  title: 'MasterAction',
  description:
    'The ONLY vocabulary the Master bot may use to change the UI. Bot 2 gets no tools at all. '
    + 'Validated identically in the AI service, the gateway and the browser.',
  type: 'object',
  required: ['name'],
  properties: { name: { $ref: '#/definitions/action_name' } },
  additionalProperties: false,
  allOf,
  definitions: { action_name: { enum: Object.keys(ACTIONS) } },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
console.log(`wrote ${OUT}`);