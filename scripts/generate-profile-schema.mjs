/**
 * WHY: `content/profile.schema.json` is the contract for the resume data that drives both the
 * static HTML and Chatbot 1's retrieval. Hand-editing a 170-line nested JSON schema reliably
 * produces an unbalanced brace, so it is generated from a compact JS object literal instead and
 * written with JSON.stringify (which cannot emit invalid JSON).
 * ALTERNATIVES: (a) hand-maintained JSON, (b) a TypeScript/Zod source with codegen.
 * WHY NOT: (a) already failed once in this session; (b) would make Python validate a derived
 *   artefact instead of the same file the Node side reads.
 * TRADE-OFF: one extra generator to keep in step with the schema. It writes the whole file, so it
 *   is the only supported way to change the schema shape.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'content', 'profile.schema.json');

const str = (extra = {}) => ({ type: 'string', ...extra });
const num = (extra = {}) => ({ type: 'number', ...extra });
const bool = { type: 'boolean' };
const enumOf = (values) => ({ enum: values });
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const obj = (properties, required = [], extra = {}) => ({
  type: 'object',
  ...(required.length ? { required } : {}),
  properties,
  additionalProperties: false,
  ...extra,
});
const ref = (name) => ({ $ref: `#/definitions/${name}` });
const oneOf = (options) => ({ oneOf: options });

const YEAR_MONTH = str({ pattern: '^[0-9]{4}(-[0-9]{2})?$' });
const PRESENT = { const: 'Present' };
const yearMonthOrPresent = oneOf([ref('yearMonth'), PRESENT]);

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://portfolio.local/schemas/profile.schema.json',
  title: 'PortfolioProfile',
  description:
    'Single source of truth for all personal content in the site and Chatbot 1. Facts are never '
    + 'invented: anything the resume does not state must be an explicitly marked TODO in '
    + 'docs/content-todos.md rather than a guess.',
  type: 'object',
  required: [
    'schema_version', 'identity', 'summary', 'skills', 'experience',
    'projects', 'education', 'certifications', 'contact', 'sections',
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: 1 },

    identity: obj({
      full_name: str({ minLength: 1 }),
      headline: str({ minLength: 1 }),
      location: str(),
      tagline: str(),
    }, ['full_name', 'headline']),

    summary: str({ minLength: 1 }),

    skills: arr(obj({
      category: str({ minLength: 1 }),
      items: arr(str(), { minItems: 1 }),
    }, ['category', 'items']), { minItems: 1 }),

    experience: arr(obj({
      employer: str(),
      role: str(),
      start: ref('yearMonth'),
      end: yearMonthOrPresent,
      location: str(),
      summary: str(),
      clients: arr(ref('clientEngagement')),
      highlights: arr(str()),
    }, ['employer', 'role', 'start', 'highlights'])),

    projects: arr(obj({
      id: str({ pattern: '^[a-z0-9-]+$' }),
      name: str(),
      blurb: str(),
      detail: str(),
      stack: arr(str()),
      highlights: arr(str()),
      links: arr(ref('link')),
      source: str(),
      visibility: enumOf(['public', 'confidential']),
    }, ['id', 'name', 'blurb'])),

    education: arr(obj({
      degree: str(),
      institution: str(),
      start: ref('yearMonth'),
      end: ref('yearMonth'),
      detail: str(),
    }, ['degree', 'institution'])),

    certifications: arr(obj({
      name: str(),
      issuer: str(),
      note: str(),
      source: str(),
    }, ['name'])),

    contact: obj({
      email: ref('contactField'),
      phone: ref('contactField'),
      linkedin: ref('contactField'),
      github: ref('contactField'),
      location: str(),
    }),

    resume: obj({
      available: bool,
      path: str(),
      label: str(),
    }),

    chatbot1: obj({
      voice: enumOf(['third', 'first']),
      persona_note: str(),
      refusal_phrase: str(),
      starter_questions: arr(str()),
    }),

    sections: arr(obj({
      id: enumOf([
        'hero', 'about', 'experience', 'projects', 'skills',
        'education', 'achievements', 'contact',
      ]),
      title: str(),
      enabled: bool,
      camera_preset: str(),
      todo: bool,
    }, ['id', 'title', 'enabled']), {
      minItems: 1,
      description: 'Ordered list driving both the 3D world stops and the HTML content layer.',
    }),

    source_register: arr(obj({
      field: str(),
      source_file: str(),
      locator: str(),
      note: str(),
    }, ['field', 'source_file', 'locator']), {
      description: 'Pointer from each content area back to where it was extracted in inputs/.',
    }),
  },

  definitions: {
    yearMonth: YEAR_MONTH,

    link: obj({
      label: str(),
      url: str(),
    }, ['label', 'url']),

    clientEngagement: obj({
      name: str(),
      project: str(),
      start: ref('yearMonth'),
      end: yearMonthOrPresent,
      summary: str(),
      highlights: arr(str()),
    }, ['name', 'project', 'highlights']),

    // WHY: `public` and `render` are owner decisions, not UI preferences. `reveal` keeps the
    // value out of crawlable HTML to reduce scraping while keeping it usable for a human.
    contactField: obj({
      value: str(),
      public: bool,
      render: enumOf(['plain', 'reveal', 'link']),
    }, ['value', 'public', 'render'], {
      description: 'render=reveal means click-to-reveal and absent from crawlable HTML.',
    }),

    min_font_scale: num({ minimum: 0.85, maximum: 1.6 }),
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
console.log(`wrote ${OUT}`);