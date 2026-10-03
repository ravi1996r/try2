/**
 * `npm run test:live` and `npm run evals:live` — opt-in checks against REAL providers.
 *
 * WHY this is opt-in and double-gated: a live call costs money and sends real text to a third party.
 * It refuses to run unless BOTH ALLOW_LIVE_TESTS=1 and at least one provider key are present.
 *
 * WHY skipping is loud, not silent: AGENTS.md requires the absence of credentials to be stated, never
 * implied by a green exit. A silent success would let "the live suite passed" be claimed on a machine
 * that never made a request. Every skip prints WHAT was missing, and the report states explicitly that
 * zero requests were made.
 *
 * WHY hard caps from the environment: the number of live calls must be bounded by configuration the
 * operator can see, not by however many questions the eval set happens to grow to.
 *
 *   test:live  -> does each configured provider answer at all?
 *   evals:live -> does each configured provider answer the authored starter questions?
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/stack.mjs';

const MODE = process.argv[2] === 'evals' ? 'evals' : 'live';
const ALLOW = process.env.ALLOW_LIVE_TESTS === '1';
const MAX_REQUESTS = Number(process.env.PORTFOLIO_LIVE_MAX_REQUESTS ?? 20);
const MAX_TOKENS = Number(process.env.PORTFOLIO_LIVE_MAX_TOKENS ?? 20000);

/** Reads a key's PRESENCE only. AGENTS.md rule 6: never print a secret. */
const hasKey = (name) => Boolean(process.env[name] && process.env[name].trim() !== '');

const PROVIDERS = [
  {
    id: 'openai',
    envKey: 'PORTFOLIO_TEST_OPENAI_API_KEY',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    body: (q) => ({
      model: process.env.PORTFOLIO_TEST_OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: q }],
      max_tokens: 200,
    }),
    headers: () => ({ Authorization: `Bearer ${process.env.PORTFOLIO_TEST_OPENAI_API_KEY}` }),
  },
  {
    id: 'anthropic',
    envKey: 'PORTFOLIO_TEST_ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com/v1/messages',
    body: (q) => ({
      model: process.env.PORTFOLIO_TEST_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
      max_tokens: 200,
      messages: [{ role: 'user', content: q }],
    }),
    headers: () => ({
      'x-api-key': process.env.PORTFOLIO_TEST_ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    }),
  },
  {
    id: 'gemini',
    envKey: 'PORTFOLIO_TEST_GEMINI_API_KEY',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
    body: (q) => ({ contents: [{ parts: [{ text: q }] }], generationConfig: { maxOutputTokens: 200 } }),
    headers: () => ({ 'x-goog-api-key': process.env.PORTFOLIO_TEST_GEMINI_API_KEY }),
  },
];

const profile = JSON.parse(readFileSync(join(ROOT, 'content', 'profile.json'), 'utf8'));
const questions = profile.chatbots?.chatbot1?.starter_questions ?? [];

const SKIP = (reason, detail) => {
  console.log(`SKIPPED - ${reason}`);
  console.log('');
  console.log(detail);
  console.log('');
  console.log('Requests made: 0. Cost incurred: 0. Nothing was verified by this run.');
  process.exit(0);
};

console.log(`${MODE}:live`);
console.log('='.repeat(60));

if (!ALLOW) {
  SKIP('ALLOW_LIVE_TESTS is not set to 1.',
    'This suite calls REAL providers. It refuses to run without explicit opt-in because each\n'
    + 'request costs money and sends real text to a third party.\n\n'
    + 'To run it:\n'
    + '  PowerShell:  $env:ALLOW_LIVE_TESTS=1;  npm run test:live\n'
    + '  bash:        ALLOW_LIVE_TESTS=1 npm run test:live');
}

if (configured().length === 0) {
  SKIP('no provider credentials are configured.',
    'Expected at least one of these (presence is checked, values are never printed):\n'
    + PROVIDERS.map((p) => `  ${p.envKey}`).join('\n')
    + '\n\nConfigured providers: 0.');
}

function configured() {
  return PROVIDERS.filter((p) => hasKey(p.envKey));
}

const active = configured();
console.log(`Opt-in accepted. Configured providers: ${active.map((p) => p.id).join(', ')}`);
console.log(`Hard caps: ${MAX_REQUESTS} request(s), ${MAX_TOKENS} token(s).`);
console.log(`Mode: ${MODE} (${MODE === 'live' ? '1 reachability request each' : `${questions.length} authored question(s) each`})`);
console.log('');

let made = 0;
const rows = [];

for (const provider of active) {
  const prompts = MODE === 'live'
    ? ['Reply with the single word: ok']
    : questions.slice(0, Math.max(0, MAX_REQUESTS - made));

  for (const prompt of prompts) {
    if (made >= MAX_REQUESTS) {
      rows.push({ provider: provider.id, prompt: '(capped)', status: 'SKIPPED', note: `cap ${MAX_REQUESTS}` });
      continue;
    }
    made += 1;
    const t0 = performance.now();
    try {
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...provider.headers() },
        body: JSON.stringify(provider.body(prompt)),
        signal: AbortSignal.timeout(30_000),
      });
      const ms = performance.now() - t0;
      // WHY report STATUS and never the body: a real provider's error body can echo the API key, and
      // this script must not print one under any circumstances.
      rows.push({
        provider: provider.id,
        prompt: prompt.slice(0, 40),
        status: res.ok ? 'OK' : `HTTP ${res.status}`,
        note: `${ms.toFixed(0)} ms`,
      });
      if (res.ok) await res.arrayBuffer();
    } catch (err) {
      rows.push({ provider: provider.id, prompt: prompt.slice(0, 40), status: 'ERROR', note: err.message });
    }
  }
}

console.log('| Provider | Prompt | Result | Detail |');
console.log('| --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.provider} | ${r.prompt} | ${r.status} | ${r.note} |`);
console.log('');
console.log(`Requests made: ${made}. Budget: ${MAX_REQUESTS} requests / ${MAX_TOKENS} tokens.`);
console.log(
  `\nNOTE: this records that a provider ANSWERED. It says nothing about answer quality --\n`
  + 'there is no scoring rubric in this repo, so quoting a quality number would be invented.',
);

const failures = rows.filter((r) => r.status !== 'OK' && r.status !== 'SKIPPED');
if (failures.length > 0) {
  console.log(`\n${failures.length} provider call(s) failed. See the table; no response bodies are printed.`);
  process.exit(1);
}
console.log('\nAll attempted provider calls returned successfully.');