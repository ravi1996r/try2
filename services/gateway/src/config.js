/**
 * Typed, validated configuration. One module per service (this one for the Node gateway;
 * services/ai has its own, because the two services must fail independently).
 *
 * WHY this shape:
 *  1. Fail fast at STARTUP, naming the missing key and never printing a value. A service that
 *     boots misconfigured and fails on the first request produces confusing errors buried deep
 *     inside request handling.
 *  2. A denylist that DROPS and never logs employer-owned variable names. Reading them at all is
 *     the hazard; a filter that "logs but ignores" still leaks the name into logs.
 *  3. Production guard: refuse to start if a concern resolved to a local engine while
 *     APP_ENV=production, unless explicitly overridden.
 *  4. Startup banner with one line per concern, labels only, no values.
 *
 * ALTERNATIVES considered:
 *  - zod: good, but it does not give an explicit denylist or "validate only the SELECTED
 *    backend's keys" for free. The gateway uses zod for request bodies, so this inconsistency is
 *    deliberate and recorded in docs/14-decision-log.md.
 *  - dotenv + ambient process.env everywhere: makes the deny list unenforceable and couples every
 *    module to global state.
 *
 * WHY NOT those: the deny list and per-backend key validation both need a single choke point, so
 * everything goes through loadConfig().
 *
 * TRADE-OFF: a hand-written parser is more code than a schema library and can drift from
 * .env.example. `npm run verify` fails on that drift (test-env-example-drift), so CI catches it
 * instead of review.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * WHY: employer-owned integrations. ServiceNow, NextThink, ADF, Direct Line and employer app
 * registrations have no place in a personal portfolio. Matching on the NAME also covers anything
 * set in the shell environment, not just .env.
 */
export const DENYLIST_PATTERNS = ['SERVICENOW', 'NEXTTHINK', 'ADF', 'DIRECTLINE', 'MICROSOFT-APP'];

/** Name fragments that mark a variable as secret, used to redact anything that gets logged. */
export const SECRET_NAME_HINTS = [
  'KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'PASSWD', 'PWD', 'CONNECTION_STRING', 'CREDENTIAL',
];

export class ConfigError extends Error {
  constructor(message, missingKeys = []) {
    super(message);
    this.name = 'ConfigError';
    this.missingKeys = missingKeys;
  }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

export function isDenylisted(name) {
  const upper = String(name).toUpperCase();
  return DENYLIST_PATTERNS.some((p) => upper.includes(p));
}

export function looksSecret(name) {
  const upper = String(name).toUpperCase();
  return SECRET_NAME_HINTS.some((h) => upper.includes(h));
}

/**
 * WHY a minimal parser instead of a dependency: it must handle `export KEY=value`, quotes,
 * comments and blank lines, which is all this project needs. That is twelve lines, and it runs
 * before anything else is imported.
 */
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length > 1
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Precedence: real environment variable > .env file > built-in default. Environment wins because a
 * deployed environment must be able to override a checked-in default without editing a file.
 *
 * @param {object} [env] process.env, injectable so tests can pass a synthetic environment.
 */
function loadRawEnv(env = process.env) {
  const raw = {};
  const filePath = join(REPO_ROOT, '.env');
  if (existsSync(filePath)) Object.assign(raw, parseEnvFile(readFileSync(filePath, 'utf8')));
  for (const [k, v] of Object.entries(env)) {
    // Denylisted names are dropped BEFORE being stored, so they cannot reach the config object,
    // a log line, or an error message.
    if (isDenylisted(k)) continue;
    if (v !== undefined) raw[k] = v;
  }
  return raw;
}

const str = (raw, key, fallback) => {
  const v = raw[key];
  return v === undefined || v === '' ? fallback : v;
};

const bool = (raw, key, fallback) => {
  const v = raw[key];
  if (v === undefined || v === '') return fallback;
  const lower = String(v).toLowerCase();
  if (TRUTHY.has(lower)) return true;
  if (FALSY.has(lower)) return false;
  throw new ConfigError(`${key} must be true or false`);
};

const int = (raw, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const v = raw[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be an integer`);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return n;
};

const num = (raw, key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const v = raw[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number`);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return n;
};

const oneOf = (raw, key, allowed, fallback) => {
  const v = str(raw, key, fallback);
  if (!allowed.includes(v)) throw new ConfigError(`${key} must be one of: ${allowed.join(', ')}`);
  return v;
};

/**
 * WHY: the production guard is DATA, not control flow scattered through the app. Collecting every
 * violation into one list means startup reports ALL problems at once instead of making the
 * operator fix them one restart at a time.
 */
export function checkProductionGuard(config) {
  const violations = [];
  if (config.appEnv !== 'production') return violations;
  if (config.allowLocalBackendsInProduction) return violations;

  const localByConcern = {
    db: config.dbBackend === 'sqlite',
    cache: config.cacheBackend === 'memory' || config.cacheBackend === 'disk',
    vector: config.vectorBackend === 'local',
    blob: config.blobBackend === 'local',
    llm: config.llmProvider === 'openai_compatible',
    embeddings: config.embeddingProvider === 'local',
    search: config.searchProvider === 'ddg' || config.searchProvider === 'none',
  };
  for (const [concern, isLocal] of Object.entries(localByConcern)) {
    if (isLocal) violations.push(concern);
  }
  if (config.fakeProvidersEnabled) violations.push('fake-providers');
  return violations;
}

/**
 * WHY: only the SELECTED backend's keys are validated. With LLM_PROVIDER=openrouter the absence of
 * AZURE_OPENAI_API_KEY must not block startup, and a missing key for the backend that IS selected
 * must fail immediately with the key's NAME and never its value.
 *
 * NOTE the `raw` parameter: this must check the RAW environment, not the `secrets` map. A previous
 * version read `config.secrets[key]`, which silently skipped non-secret required keys such as
 * OPENROUTER_MODEL and LLM_BASE_URL, so production started without them. Caught by
 * `config: fail-fast naming only the missing key > keys for UNSELECTED backends are not required`.
 *
 * @param {object} config resolved config
 * @param {object} raw raw (denylist-filtered) environment values
 * @returns {string[]} missing key NAMES, never values
 */
export function missingKeysFor(config, raw = {}) {
  const missing = [];
  const need = (cond, key) => {
    if (!cond) return;
    const value = raw[key] ?? config.secrets[key];
    if (!value) missing.push(key);
  };

  need(config.llmProvider === 'openrouter', 'OPENROUTER_API_KEY');
  need(config.llmProvider === 'openrouter', 'OPENROUTER_MODEL');
  need(config.llmProvider === 'openai_compatible', 'LLM_BASE_URL');
  need(config.llmProvider === 'openai_compatible', 'LLM_MODEL');
  need(config.llmProvider === 'azure_openai', 'AZURE_OPENAI_ENDPOINT');
  need(config.llmProvider === 'azure_openai', 'AZURE_OPENAI_API_KEY');
  need(config.llmProvider === 'azure_openai', 'AZURE_OPENAI_CHAT_DEPLOYMENT');

  need(config.embeddingProvider === 'azure_openai', 'AZURE_OPENAI_ENDPOINT');
  need(config.embeddingProvider === 'azure_openai', 'AZURE_OPENAI_API_KEY');

  need(config.dbBackend === 'mongodb', 'MONGODB_URI');
  need(config.cacheBackend === 'redis', 'REDIS_URL');
  need(config.vectorBackend === 'azure_search', 'AZURE_SEARCH_ENDPOINT');
  need(config.vectorBackend === 'azure_search', 'AZURE_SEARCH_API_KEY');
  need(config.blobBackend === 'azure_blob', 'AZURE_BLOB_CONNECTION_STRING');
  need(config.searchProvider === 'brave', 'PORTFOLIO_SEARCH_API_KEY');

  return missing;
}
/**
 * WHY secrets are collected into a separate `secrets` map: it makes the blast radius obvious. Code
 * that wants a secret must reach into one explicitly-named place, and the redaction helper can
 * scrub that map without scrubbing ordinary config.
 */
const SECRET_KEYS = [
  'OPENROUTER_API_KEY', 'LLM_API_KEY', 'AZURE_OPENAI_API_KEY', 'PORTFOLIO_SEARCH_API_KEY',
  'PORTFOLIO_INTERNAL_SERVICE_AUTH', 'PORTFOLIO_SESSION_SECRET',
  'MONGODB_URI', 'REDIS_URL', 'AZURE_SEARCH_API_KEY', 'AZURE_BLOB_CONNECTION_STRING',
  'APPLICATIONINSIGHTS_CONNECTION_STRING', 'TURNSTILE_SECRET_KEY',
];

/**
 * Builds the full config object. Pure with respect to its input, so tests can call it with a
 * synthetic environment and assert on the result without mutating global state.
 *
 * @param {object} [env]
 * @returns {object} frozen config
 */
export function loadConfig(env = process.env) {
  const raw = loadRawEnv(env);

  const appEnv = oneOf(raw, 'APP_ENV', ['local', 'production'], 'local');
  const useLocalFallbacks = bool(raw, 'USE_LOCAL_FALLBACKS', appEnv === 'local');

  const config = {
    appEnv,
    useLocalFallbacks,
    logLevel: oneOf(raw, 'PORTFOLIO_LOG_LEVEL', ['debug', 'info', 'warn', 'error'], 'info'),

    siteOrigin: str(raw, 'SITE_ORIGIN', 'http://localhost:5173').replace(/\/+$/, ''),
    host: str(raw, 'GATEWAY_HOST', '127.0.0.1'),
    port: int(raw, 'GATEWAY_PORT', 8082, { min: 1, max: 65535 }),
    aiServiceBaseUrl: str(raw, 'AI_SERVICE_BASE_URL', 'http://127.0.0.1:8080').replace(/\/+$/, ''),

    allowLocalBackendsInProduction: bool(raw, 'PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION', false),
    dataDir: resolve(REPO_ROOT, str(raw, 'PORTFOLIO_DATA_DIR', './data')),

    dbBackend: oneOf(raw, 'DB_BACKEND', ['sqlite', 'mongodb'], 'sqlite'),
    cacheBackend: oneOf(raw, 'CACHE_BACKEND', ['memory', 'disk', 'redis'], 'memory'),
    // WHY these two are read here: REDIS_URL was validated as REQUIRED when CACHE_BACKEND=redis
    // (see the need() guard) but never surfaced on the config object, so the registry could not see
    // the URL it was required to connect with. Declaring a variable is not the same as using it.
    redisUrl: str(raw, 'REDIS_URL', ''),
    redisKeyPrefix: str(raw, 'REDIS_KEY_PREFIX', 'portfolio:local'),
    vectorBackend: oneOf(raw, 'VECTOR_BACKEND', ['local', 'azure_search'], 'local'),
    blobBackend: oneOf(raw, 'BLOB_BACKEND', ['local', 'azure_blob'], 'local'),

    llmProvider: oneOf(raw, 'LLM_PROVIDER', ['openrouter', 'openai_compatible', 'azure_openai'], 'openrouter'),
    llmBaseUrl: str(raw, 'LLM_BASE_URL', ''),
    llmModel: str(raw, 'LLM_MODEL', ''),
    openrouterModel: str(raw, 'OPENROUTER_MODEL', ''),
    azureOpenaiApiVersion: str(raw, 'AZURE_OPENAI_API_VERSION', '2024-10-21'),
    azureOpenaiChatDeployment: str(raw, 'AZURE_OPENAI_CHAT_DEPLOYMENT', ''),
    azureOpenaiEmbeddingsDeployment: str(raw, 'AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT', 'portfolio-embeddings'),
    llmTimeoutMs: int(raw, 'LLM_TIMEOUT_MS', 30000, { min: 1000, max: 300000 }),
    llmMaxOutputTokens: int(raw, 'LLM_MAX_OUTPUT_TOKENS', 800, { min: 16, max: 32000 }),
    contextTokenBudget: int(raw, 'PORTFOLIO_CONTEXT_TOKEN_BUDGET', 6000, { min: 500, max: 200000 }),

    embeddingProvider: oneOf(raw, 'EMBEDDING_PROVIDER', ['local', 'azure_openai'], 'local'),
    embeddingDim: int(raw, 'EMBEDDING_DIM', 384, { min: 8, max: 4096 }),
    embeddingModelId: str(raw, 'EMBEDDING_MODEL_ID', 'local-hashed-ngram-v1'),

    searchProvider: oneOf(raw, 'PORTFOLIO_SEARCH_PROVIDER', ['ddg', 'brave', 'none'], 'ddg'),
    searchMaxResults: int(raw, 'PORTFOLIO_SEARCH_MAX_RESULTS', 5, { min: 1, max: 25 }),
    searchMaxQueriesPerSession: int(raw, 'PORTFOLIO_SEARCH_MAX_QUERIES_PER_SESSION', 8, { min: 0, max: 1000 }),
    searchCacheTtlSeconds: int(raw, 'PORTFOLIO_SEARCH_CACHE_TTL_SECONDS', 300, { min: 0, max: 86400 }),

    rateLimitPerIpPerMinute: int(raw, 'PORTFOLIO_RATE_LIMIT_PER_IP_PER_MINUTE', 20, { min: 1, max: 100000 }),
    rateLimitPerSessionPerMinute: int(raw, 'PORTFOLIO_RATE_LIMIT_PER_SESSION_PER_MINUTE', 30, { min: 1, max: 100000 }),
    dailyTokenBudget: int(raw, 'PORTFOLIO_DAILY_TOKEN_BUDGET', 200000, { min: 0, max: 1e12 }),
    requestMaxBytes: int(raw, 'PORTFOLIO_REQUEST_MAX_BYTES', 65536, { min: 1024, max: 1e8 }),
    historyMaxMessages: int(raw, 'PORTFOLIO_HISTORY_MAX_MESSAGES', 12, { min: 0, max: 100 }),
    sessionTtlSeconds: int(raw, 'PORTFOLIO_SESSION_TTL_SECONDS', 1800, { min: 60, max: 86400 }),
    internalServiceAuthTtlSeconds: int(raw, 'PORTFOLIO_INTERNAL_SERVICE_AUTH_TTL_SECONDS', 300, { min: 30, max: 3600 }),

    botChallengeEnabled: bool(raw, 'PORTFOLIO_BOT_CHALLENGE_ENABLED', false),
    allowAnyHttpsEndpoint: bool(raw, 'PORTFOLIO_ALLOW_ANY_HTTPS_ENDPOINT', false),
    cspScriptSrc: str(raw, 'PORTFOLIO_CSP_SCRIPT_SRC', "'self'"),
    cspStyleSrc: str(raw, 'PORTFOLIO_CSP_STYLE_SRC', "'self'"),

    telemetryEnabled: bool(raw, 'PORTFOLIO_TELEMETRY_ENABLED', false),

    dropzone: {
      maxFiles: int(raw, 'PORTFOLIO_DROPZONE_MAX_FILES', 5, { min: 1, max: 100 }),
      maxFileBytes: int(raw, 'PORTFOLIO_DROPZONE_MAX_FILE_BYTES', 10485760, { min: 1024, max: 1e9 }),
      maxTotalPages: int(raw, 'PORTFOLIO_DROPZONE_MAX_TOTAL_PAGES', 100, { min: 1, max: 10000 }),
      maxUrlFetches: int(raw, 'PORTFOLIO_DROPZONE_MAX_URL_FETCHES', 5, { min: 0, max: 100 }),
      urlTimeoutSeconds: int(raw, 'PORTFOLIO_DROPZONE_URL_TIMEOUT_SECONDS', 10, { min: 1, max: 120 }),
      urlMaxResponseBytes: int(raw, 'PORTFOLIO_DROPZONE_URL_MAX_RESPONSE_BYTES', 5242880, { min: 1024, max: 1e9 }),
      urlMaxRedirects: int(raw, 'PORTFOLIO_DROPZONE_URL_MAX_REDIRECTS', 3, { min: 0, max: 10 }),
      idleTtlSeconds: int(raw, 'PORTFOLIO_DROPZONE_IDLE_TTL_SECONDS', 1800, { min: 60, max: 86400 }),
      maxContextTokens: int(raw, 'PORTFOLIO_DROPZONE_MAX_CONTEXT_TOKENS', 6000, { min: 500, max: 200000 }),
    },

    allowLiveTests: bool(raw, 'ALLOW_LIVE_TESTS', false),
    liveMaxRequests: int(raw, 'PORTFOLIO_LIVE_MAX_REQUESTS', 20, { min: 1, max: 10000 }),
    liveMaxTokens: int(raw, 'PORTFOLIO_LIVE_MAX_TOKENS', 20000, { min: 1, max: 1e9 }),

    fakeProvidersEnabled: bool(raw, 'PORTFOLIO_FAKE_PROVIDERS', false),
    fakeProviders: {
      port: int(raw, 'FAKE_PROVIDERS_PORT', 8090, { min: 1, max: 65535 }),
      ollamaPort: int(raw, 'FAKE_PROVIDERS_OLLAMA_PORT', 8091, { min: 1, max: 65535 }),
      anthropicPort: int(raw, 'FAKE_PROVIDERS_ANTHROPIC_PORT', 8092, { min: 1, max: 65535 }),
      geminiPort: int(raw, 'FAKE_PROVIDERS_GEMINI_PORT', 8093, { min: 1, max: 65535 }),
      searchPort: int(raw, 'FAKE_PROVIDERS_SEARCH_PORT', 8094, { min: 1, max: 65535 }),
    },

    secrets: {},
  };

  // WHY: the visitor's API key must never reach us. Any key-like field or provider auth header on
  // a request to OUR API is rejected at the edge; this list drives that check and the log scrubber.
  config.keyLikeFieldNames = [
    'api_key', 'apiKey', 'authorization', 'x-api-key', 'anthropic_api_key',
    'openai_api_key', 'gemini_api_key', 'access_token', 'bearer',
  ];

  for (const key of SECRET_KEYS) {
    const v = raw[key];
    if (v) config.secrets[key] = v;
  }

  // WHY: an empty site-model key is NOT a startup error. The point of local-first is that `verify`
  // runs with zero credentials; chat then reports "Site model unavailable: no model configured" and
  // offers the switcher. Only PRODUCTION demands a key for the selected backend.
  if (config.appEnv === 'production') {
    const missing = missingKeysFor(config, raw);
    if (missing.length) {
      throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`, missing);
    }
  }

  config.productionGuardViolations = checkProductionGuard(config);

  return Object.freeze(config);
}

/**
 * WHY redaction is a helper: the rule "never log a secret value" is only real if it is enforced in
 * one place. Every log call routes values through this, so a new log line cannot leak a secret.
 */
export function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return '<redacted>';
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = looksSecret(k) ? '<redacted>' : (v && typeof v === 'object' ? redact(v) : v);
  }
  return out;
}

/**
 * WHY a banner and not a config dump: operators need to see WHICH backends are active at a glance,
 * but a full dump is a secret-disclosure risk. Labels only, never values.
 */
export function startupBanner(config) {
  const lines = [
    `[config] APP_ENV=${config.appEnv} USE_LOCAL_FALLBACKS=${config.useLocalFallbacks}`,
    `[config] db=${config.dbBackend} cache=${config.cacheBackend} vector=${config.vectorBackend} blob=${config.blobBackend}`,
    `[config] llm=${config.llmProvider} embeddings=${config.embeddingProvider} search=${config.searchProvider}`,
    `[config] origin=${config.siteOrigin} gateway=${config.host}:${config.port} ai=${config.aiServiceBaseUrl}`,
  ];
  if (config.productionGuardViolations.length) {
    lines.push(`[config] PRODUCTION GUARD VIOLATIONS: ${config.productionGuardViolations.join(', ')}`);
  }
  if (config.fakeProvidersEnabled) lines.push('[config] WARNING: fake providers ENABLED (test mode only)');
  return lines.join('\n');
}
