// WHY: The wire vocabulary lives in ONE file and is loaded by both the Node gateway and the
// Python AI service. Two hand-written copies of an event schema always drift, and a drift bug
// between gateway and AI service is invisible until a user sees a broken stream.
// ALTERNATIVES: (a) OpenAPI-first with codegen, (b) Protobuf/gRPC, (c) duplicate hand-written types.
// WHY NOT: (a) does not model an SSE event stream well; (b) adds a build step and a compiler the
//   project otherwise does not need, and SSE is the transport; (c) is the drift bug itself.
// TRADE-OFF: JS + Python both validate this same file with their own validator, so the shared file
//   must stay within the JSON Schema draft-07 subset both support. Tests assert both sides accept
//   and reject the same fixtures.

/** Bot identifiers. Contexts stay separate: different prompt, memory and retrieval scope. */
export const BOTS = /** @type {const} */ (['bot1', 'bot2', 'bot3']);

export const BOT_LABELS = {
  bot1: 'About Ravi',
  bot2: 'Research (Drop-Zone)',
  bot3: 'Site Master',
};

/** Terminal + intermediate states. Every long operation shows one; no infinite spinners. */
export const STATUS_STATES = /** @type {const} */ ([
  'queued',
  'processing',
  'retrieving',
  'streaming',
  'retrying',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

export const ERROR_CODES = /** @type {const} */ ([
  'validation',
  'provider_unavailable',
  'quota_exceeded',
  'context_limit',
  'retrieval_failure',
  'rate_limited',
  'budget_exhausted',
  'not_configured',
  'internal',
]);

/**
 * WHY: retryability is data, not a UI guess. The client must decide whether to auto-retry from a
 * flag the server computed, so the two halves can never disagree about what a 429 means.
 */
export const RETRYABLE_CODES = new Set(['provider_unavailable', 'rate_limited']);

/** Drop-Zone search scope. `sources_only` must never trigger a web search call (asserted by tests). */
export const SEARCH_SCOPES = /** @type {const} */ (['sources_only', 'sources_and_web']);

/** Source kinds used in citation chips. */
export const SOURCE_KINDS = /** @type {const} */ ([
  'resume_section',
  'project',
  'file',
  'url',
  'web',
]);

/**
 * WHY: the client needs to know WHICH model produced an answer and WHICH key paid for it.
 * Without this badge a visitor cannot tell their own model from the site model, which is an
 * honesty failure, not a cosmetic one.
 */
export const PATHS = /** @type {const} */ (['site', 'browser']);

/** Allowlist of open-licensed, self-hostable font families (section 3.5). */
export const FONT_ALLOWLIST = /** @type {const} */ ([
  'Inter',
  'JetBrains Mono',
  'Space Grotesk',
  'IBM Plex Sans',
  'IBM Plex Mono',
  'Source Sans 3',
  'Sora',
  'Bitter',
  'Nunito Sans',
  'Atkinson Hyperlegible',
]);

/**
 * WHY: the Master bot must never be able to lock a visitor out of the page. Fonts are therefore
 * an allowlist and font size has hard floors. These constants are the shared floor used by the
 * Python validator, the gateway validator and the browser validator so all three agree.
 */
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.6;

/** Minimum body-text contrast ratio required by WCAG AA (section 4.3). */
export const MIN_BODY_CONTRAST = 4.5;

/**
 * WHY: themes must be DATA, not bespoke CSS. A theme is a token set + scene config validated
 * against this schema, so adding a theme is one file plus one scene module.
 */
export const THEME_NAMES = /** @type {const} */ ([
  'chill',
  'cyberpunk',
  'fantasy',
  'retro',
  'modern',
]);

/**
 * WHY: master action names are an allowlist shared by the AI service (which emits them), the
 * gateway (which forwards them) and the browser (which applies them). Bot 2 never gets tools.
 */
export const ACTION_NAMES = /** @type {const} */ ([
  'set_theme',
  'set_font',
  'set_font_size',
  'set_accent',
  'toggle_motion',
  'set_quality',
  'set_camera_preset',
  'scroll_to_section',
  'open_chatbot',
  'close_chatbot',
  'set_layout',
  'toggle_sound',
  'set_volume',
  'toggle_high_contrast',
  'toggle_dyslexia_friendly_font',
  'reset_ui',
  'undo',
  'redo',
  'open_model_settings',
]);

export const QUALITY_TIERS = /** @type {const} */ (['low', 'medium', 'high', 'auto']);
export const MOTION_MODES = /** @type {const} */ (['on', 'off', 'reduced']);

/**
 * WHY: SSRF protection needs the block list in ONE place. The fetcher, the URL validator and the
 * tests must agree on exactly which address ranges are refused, including decimal/octal/hex and
 * IPv4-mapped IPv6 encodings.
 */
export const BLOCKED_IP_LABELS = /** @type {const} */ ([
  'loopback',
  'private',
  'link_local',
  'cgnat',
  'multicast',
  'reserved',
  'unique_local',
  'unspecified',
  'metadata',
]);

/** Only 80/443 are fetchable (section 6). */
export const ALLOWED_URL_PORTS = [80, 443];