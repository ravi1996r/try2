# PROGRESS

**Current phase:** Phase 2 — the three bots, themes as data, and production-quality gates.
**Last full test run:** `npm run verify` → **PASSED in 43.5s.**
`npx vitest run` → **328 passed / 328**;
`pytest services/ai/tests` → **237 passed**;
`npm run test:integration` → **21 passed** (real processes);
`npx playwright test` → **11 passed** (real gateway + real SSE).
Total **597 tests, 0 skipped, 0 failing.**
`npm run perf:budget` → **PASSED**, hero JS at 85% of its gzipped budget.

**Every task declared in package.json is implemented.**
**Branch:** `dev`, pushed. Everything is committed — see "Branch and commit state" below.

## Verified status

| Component | Label | Evidence |
| --- | --- | --- |
| `content/profile.json` + schema | Implemented | `node scripts/validate-content.mjs` → valid; 8 sections, 17 source pointers |
| `packages/contracts` | Implemented | 19-action Master schema + SSE vocabulary, generated + parse-valid |
| Gateway typed config | Implemented | 12 tests: denylist drops employer vars; fail-fast names only the key; production guard |
| `KeyValueStore` + conformance | Implemented | conformance suite passes on memory + disk; 9 tests |
| SSRF classifier + URL guard | Implemented | **120 tests** — decimal/hex/octal/IPv4-mapped/expanded IPv6 all blocked |
| Fake providers | Implemented | 22 tests — 4 wire formats, fault injection, CORS toggle, request log |
| Model Gateway + SSE | Implemented | 11 tests — real streamed round trip, **upstream abort proven**, error mapping |
| CSP / headers / rate limit / budget | Implemented | written; dedicated header tests **not yet written** |
| Local embedder | **Experimental** | 20 tests; measured `FastAPI`↔`Fast API` 0.45 → **0.838** after camelCase split |
| Chunking + hybrid retrieval | Implemented | 30 tests — real profile.json, RRF fusion, per-session isolation, persistence |
| Static site generator | Implemented | 32 tests — escaping, a11y structure, **reveal fields absent from HTML** |
| Secret scanner | Implemented | 12 tests — 6 planted secret classes detected; never echoes a value |
| Env drift check | Implemented | 4 tests — both directions; `planned` marker requires a reason |
| Task runner (`scripts/run.mjs`) | Implemented | 5 tests; unknown/unimplemented tasks exit 1 with a reason |
| Incremental canary guard | Implemented | 12 tests — a canary split across 13 chunk boundaries never leaks a char |
| CSP / security headers | Implemented | 8 tests **+ 4-mutation gate** proving the tests fail when the policy weakens |
| CORS ordering | Implemented | 8 tests — blocked origin + malformed JSON returns 403, not a parser error |
| Production startup guard | Implemented | 9 tests — `startServer()` refuses; the guard is no longer advisory |
| React enhancement layer | **Verified in a browser** | 6 Playwright tests against `dist/` + the gateway's real CSP |
| `typecheck` (`tsc --noEmit`) | Implemented | runs `apps/web/tsconfig.json` in the gate |
| `npm run build` | Implemented | generator + Vite bundle; 8 tests assert the CSP invariant on the real artifact |
| `npm run dev` | Implemented | **all 4 services verified up**: web 200, gateway 200, AI 200, fake 200 |
| Port preflight | Implemented | 7 tests bind real sockets; `dev` refuses with an actionable message, exit 1 |
| `npm run lint` | Implemented | 5 rules; 4/5 verified against planted violations |
| `services/ai/requirements.txt` | Implemented | was **missing**; captured from the installed venv, `--dry-run` clean |
| `test:e2e` (Playwright + axe) | Implemented | 6 tests; a11y proven to bite (planted contrast violation caught, 25 nodes) |
| **Cross-process chat (1.13)** | **Implemented** | 8 tests: gateway → Python AI service → fake provider, real processes, clean teardown |
| **Backend switch** | **Implemented** | one registry; the requested kind is honoured or startup fails with a remedy. 8 tests |
| Bot 3 Master actions | **Implemented** | 16 validator + 11 store + 6 cross-process tests; `tool_call` streams and the browser applies it |
| Bot 2 Drop-Zone safety | **Implemented** (answer path) | 29 type-sniffing + 18 trust-fencing tests; no upload endpoint yet |
| Themes as data | **Implemented** | `THEME_REGISTRY` + `validateTheme()`; 8 tests incl. WCAG AA contrast on all five |
| Perf budgets | **Implemented** | bundle gate in `verify`; 17 tests on the degradation decision |

### Task 1.13 is now DONE, not partial
`tests/integration/` boots the fake providers, the **Python AI service** and the gateway as three
separate processes and drives a real `POST /v1/chat/stream`. It proves the hop that every earlier
test stubbed out:
- retrieval sources come back from the **real SQLite index** built from `profile.json`
  (sources can only exist if the gateway called the AI service AND it queried the index)
- every SSE frame validates against `packages/contracts/schemas/event.schema.json`
- the canary marker and source fences never reach visitor-visible text
- an unknown bot gets a `400` and **zero** frames; a provider credential in a header gets a `400`
  and is never echoed
- ports 18080/18082/18090 keep the dev ports free; teardown leaks no processes and no ports

### The one result that mattered
**The production CSP does not block the React bundle.** Proven in Chromium with the real
`script-src 'self'` header applied *and asserted present*, zero console CSP violations, and `#root`
confirmed to receive React's output. This was the open risk carried over from the Next.js comparison.

| **Three.js scene** | **Implemented** | real render loop, 60.0 FPS measured, 0 long frames, code-split into `Scene.js` |
| Scroll navigation | Implemented | IntersectionObserver + `aria-current`; no scroll handler |
| Chat UI (bot1/2/3) | Implemented | SSE client, schema-typed frames, abort, sources |
| `/v1/prepare` (browser path) | Implemented | 4 integration tests incl. credential refusal |
| Browser-direct adapters | Implemented | OpenAI / Anthropic / Ollama, key never leaves the browser |
| Model switcher panel | Implemented | 3 E2E tests: cost label, `type=password`, never persisted |
| **Browser-direct chat dispatch** | **Implemented** | `/v1/prepare` → provider directly; key never leaves the browser |
| E2E runs the real gateway | Implemented | 2nd `webServer` boots the stack; chat tests do real SSE (1.7 s) |

### Not yet implemented
- **Bot 2 upload surface.** The *answer* path is complete: type sniffing, session isolation, trust
  fencing and the context budget are all built and tested. Nothing can put a document into the index
  yet, so a Bot 2 turn retrieves nothing and says so. The SSRF-safe URL fetcher and TTL cleanup are
  also outstanding.
- **Per-theme scene modules.** Themes are data with a validated `scene` config (geometry kind, motion,
  camera presets), but `scenes/` holds no per-theme modules yet, so every theme still renders through
  the single shared scene. The config is ready; the loader that turns it into a lazy chunk is not.
- **MongoDB and Azure adapters.** The selectors are read, validated and honestly reported. Only the
  Redis adapter is implemented.

### Known limits, stated plainly
- **Bot 3 works; Bot 2 does not yet.** Bot 3 plans validated UI actions and the browser applies them.
  Bot 2 fences and isolates correctly but cannot receive a document.
- **Bot 3's plan is deterministic, not model-generated.** This is a deliberate design decision, not a
  gap — see `services/ai/app/bot3.py`. The model narrates; it does not choose.
- **The browser path is untested against a real provider.** `test:live` is key-gated and was skipped
  with no credentials. The adapter request/parse code is exercised only structurally; no OpenAI,
  Anthropic or Ollama endpoint has actually been called from the browser in this session.
- **Bot 2 refuses PDF, DOCX and every other binary format.** A file is text or it is refused. That
  costs real formats and is deliberate: a parser written for well-formed input, fed untrusted bytes, is
  an attack surface. `dropzone.sniff_type` types by CONTENT, so `notes.txt` holding an executable is
  refused.
- **E2E binds the documented ports** (8080/8082/8090). A running `npm run dev` will make the gate fail
  on a port conflict. That is deliberate — a silent attach to a foreign process would be worse.

### Measured this session (real hardware, real processes)
| Harness | Command | Result |
| --- | --- | --- |
| Load | `npm run load` | 24/24 HTTP 200, 39.17 req/s @ concurrency 8, p50 188 ms, p95 230 ms |
| Perf | `npm run perf:local` | 60.0 FPS mean, p50 16.70 ms, 0 long frames, 9.5 MiB heap, Intel UHD via ANGLE |
| Ingest | `npm run index:rebuild` | 34 chunks, idempotent on re-run |
| Reset | `npm run data:reset` | 1 item, 116.0 kB freed |
| Trace | `npm run traceability` | 57 features, 17 test files |

Both `load` and `perf:local` print an explicit SCOPE note: they measure **this** system against a local
fake on **this** machine, and neither supports a claim about a real provider.

### Open items, honestly recorded
- **Unexplained test flake.** The resume-link test timed out on `a[href$=".pdf"]` while the same
  selector worked in a standalone script and the element provably exists in the HTML. Rewritten to
  assert the href *value* instead. Root cause **not** diagnosed; recorded rather than hidden.
- **Dev serves one inline script.** Vite's React Fast Refresh preamble, injected by
  `transformIndexHtml` in dev only. The dev server sends no CSP so it runs. Production
  `dist/index.html` has **zero** inline scripts (asserted), and the gateway CSP governs production.
- **HSTS is asserted absent** in E2E because `securityHeaders()` adds it only when
  `appEnv === 'production'`; the E2E server runs as `local`.
- **Integration tests use a throwaway data dir.** `PORTFOLIO_DATA_DIR` points at a temp directory,
  so the index is rebuilt per run (~2s). They never touch the developer's real `./data`.

## Branch and commit state

Everything below is **committed and pushed to `dev`**. `AGENTS.md` rule 7 forbids `git push`; the
repository owner authorised it explicitly for this branch, so the rule and the instruction now disagree
and rule 7 should be amended rather than quietly ignored.

| Commit | What landed |
| --- | --- |
| `abac465` | Full local-first stack, frontend and toolchain (431 tests at the time) |
| `26fd760` | Backend switch made real: one registry, no silent fallback, honest `/healthz` |
| `baa7dd8` | Backend selectors now read by the process that actually owns them |
| `d9d195b` | Bot 3 end to end: planner, gateway `tool_call` stream, browser dispatch, undo/redo/reset |
| `97fead0` | Bot 2 trust fencing, content-based type sniffing, session isolation |
| `52fed36` | Themes as data with a validator; perf budgets wired into `verify` |

## Gate scope, stated honestly

`verify` runs, in order: content validation → generator tests → `build` → **`perf:budget`** → vitest →
pytest → secret scan → env drift → **`test:integration`** → **`test:e2e`**. Last measured:
**43.5 s, all green.**

Measured budget headroom from a real production build, not a constant:

| Artifact | Gzipped | Budget | Used |
| --- | --- | --- | --- |
| `dist/assets/main.js` (hero) | 78,337 B | 92,160 B | 85% |
| `dist/assets/Scene.js` (lazy) | 116,730 B | 133,120 B | 88% |
| `dist/assets/site.css` | 1,395 B | 12,288 B | 11% |

**Still not in the gate:** the live-provider suites (`test:live`, `evals:live`) need real keys and are
opt-in; `perf:local` and `load` measure against a local fake on this machine and cannot support a claim
about a real provider, so they stay manual. `perf:budget` covers bundle size, not runtime frame time —
the frame-time budget is implemented and unit-tested but a browser frame-time gate is not wired into CI.

## Task checklist

| # | Task | Status |
| --- | --- | --- |
| 0.1–0.5 | Content, schemas, plan, AGENTS.md, env/git files | done |
| 1.1 | Shared contracts | done |
| 1.2–1.3 | Gateway config + tests | done |
| 1.4 | `KeyValueStore` (memory, disk) + conformance suite | done |
| 1.6 | Fake provider server, 4 wire formats | done |
| 1.9 | SSRF IP classifier + URL guard + corpus | done |
| 1.10a | Local embedder (Experimental) | done |
| 1.10b | Chunking + hybrid retrieval | done |
| 1.11 | Express server + `/v1/chat/stream` SSE endpoint | **done** |
| 1.12 | Python AI service (FastAPI) exposing retrieval | **done** |
| 1.13 | End-to-end: browser → gateway → AI service → provider | **done** — 8 cross-process tests, real processes |
| 1.14 | `verify:fast` / `verify` runner scripts | **done** — `scripts/run.mjs`, full gate 26.3s |
| 1.15 | gitleaks config + secret-leak scan | **done** — `scripts/secret-scan.mjs` (4 signals, 12 tests) |
| 1.16 | Security-header unit tests | **done** — 8 tests, plus a 4-mutation gate proving they bite |
| 1.17 | `.env.example` ↔ code drift gate | **done** — `scripts/check-env-drift.mjs`, 4 tests |
| 1.18 | Static site generator (prerender + 2D fallback base) | **done** — 32 tests |
| 1.19 | Incremental canary-safe streaming | **done** — bounded-overlap guard, 12 tests |
| 1.20 | CORS before JSON body parsing | **done** — 8 ordering tests |
| 1.21 | Production guard refuses startup | **done** — 9 tests |
| 1.22 | Frontend foundation: React enhancement over prerendered HTML | **done** — ADR-0011, 8 CSP-invariant tests |
| 1.23 | `typecheck` gate (`tsc --noEmit`) | **done** — in `verify` |
| 1.24 | Real `npm run build` (generator + Vite bundle) | **done** — `dist/index.html` + `dist/assets/main.js` |
| 1.25 | Three.js scene, theme transitions, navigation, contact reveal | **done** — scene + nav + reveal; themes are now validated data, per-theme scene modules pending |
| 1.26 | Chat UI (Bot 2 / Bot 3) and model switcher | **partial** — Bot 3 works end to end; Bot 2's answer path is built but has no upload surface |
| 2.1 | Bot 3 Master actions: shared validator, gateway stream, browser dispatch, undo/redo/reset | **done** — 16 validator + 11 store + 6 cross-process tests |
| 2.2 | Bot 2 Drop-Zone: type sniffing, session isolation, trust fencing, context budget | **partial** — all four built and tested; upload endpoint, URL fetcher and TTL cleanup outstanding |
| 2.3 | Themes as data: token + scene config schemas, validator, safe transitions, reduced motion | **partial** — registry and validator done, 8 tests; per-theme lazy scene modules outstanding |
| 2.4 | Perf budgets in CI: gzipped hero JS, CLS, draw calls, frame time, low-FPS degradation | **partial** — bundle gate in `verify` + frame-time degradation unit-tested; CLS/draw-call not measured in CI |
| 1.17 | Phase 1 report | pending |
| 1.27 | `npm run dev`: 4-service supervisor + port preflight | **done** — all 4 verified 200, 7 tests |
| 1.28 | `npm run lint` (project rules, no ESLint) | **done** — 5 rules, in the gate |
| 1.29 | `services/ai/requirements.txt` (was missing) | **done** — captured from installed venv |
| 1.30 | Ingestion CLI + `npm run index:rebuild` | **done** — 34 chunks, idempotent |
| 1.31 | `npm run data:reset` (guarded wipe of derived data) | **done** — refuses paths outside the repo |
| 1.32 | `npm run traceability` (generated matrix) | **done** — 57 features, derived from PROGRESS |
| 1.33 | `npm run load` (concurrency vs local fake) | **done** — 24/24, 39.17 req/s, p95 230 ms |
| 1.34 | `npm run perf:local` (FPS/heap on real GPU) | **done** — 60.0 FPS, 0 long frames |
| 1.35 | `npm run test:live` / `evals:live` (opt-in, key-gated) | **done** — explicit skip, hard caps, no secrets printed |
| 1.36 | Contact-reveal API + browser hook | **done** — 3 integration tests |
| 1.37 | Five themes with full token palettes | **done** — 3 drift tests, verified to bite |
| 1.17 | Phase 1 report | pending |

## Next three tasks
1. **Bot 2 upload endpoint** — accept a file, run `sniff_type`, chunk it with a server-derived session,
   and delete on request. The safety layers are already tested; this is the surface that feeds them.
2. **Per-theme scene modules** — a loader that turns each theme's `scene.kind` into a lazy chunk, so the
   config that already exists becomes the behaviour. Needs safe disposal on transition.
3. **CLS and draw-call measurement in the gate** — `perf:budget` currently checks bytes only. A
   Playwright layout-shift measurement and a `renderer.info` draw-call read would close the gap the
   frame-time budget already covers in unit tests.

## Real bugs caught by tests (recorded per rule 1.4)

Earlier sessions:

1. `missingKeysFor` read only `config.secrets`, silently skipping `OPENROUTER_MODEL` / `LLM_BASE_URL`.
2. Disk `KeyValueStore` never hydrated from disk — persistence looked fine, lost everything on restart.
3. Deleted keys resurrected on restart (stale seed object re-serialised).
4. `::ffff:127.0.0.1` labelled `invalid` instead of `loopback` (character guard ran before mapped check).
5. Gemini routing matched lowercase `generateContent`; real method is `streamGenerateContent`.
6. `_load_vectors` selected a `text` column from `chunk_meta`, which does not have one.
7. `_WORD_RE = [a-z0-9]+` dropped leading capitals, so "Quick" tokenised to "uick".
8. `FAKE_MARKER` conflated header name with header line → `ERR_INVALID_HTTP_TOKEN`, suite hung 320s.
9. Two suites bound port 8090 simultaneously → real `EADDRINUSE`; fixed with per-worker port offset.

This session:

10. **`/healthz` claimed Redis while running memory.** `CACHE_BACKEND=redis` was accepted, reported as
    `"cache": "redis"`, and then silently served from the in-memory store. `REDIS_URL` was even marked
    *required* in that mode and never read.
11. **The gateway reported backends it does not own.** `DB_BACKEND` / `VECTOR_BACKEND` / `BLOB_BACKEND`
    were validated and echoed by the gateway while the AI service — which actually uses them — never
    read them at all. A health report about a value a process never consumes is a false claim.
12. **`"turn off high contrast"` enabled it.** The negation list matched whole phrases, so the most
    natural phrasing missed it entirely. Replaced with a proximity check plus 12 tests.
13. **`/healthz` read a `createApp` local from a route mounted by a different function.** A
    `ReferenceError` that only appeared when the gateway booted for real — every unit test injects a
    store, so none of them executed that path. The cross-process suite caught it.
14. **UTF-16 files were refused as binary**, because the NUL scan ran before the decode and UTF-16 is
    NUL in every other byte. Then every UTF-16 file was refused as a JPEG, because non-ASCII signature
    bytes decoded to `""` and `str.startswith("")` is always true.
15. **Five invented `bodyContrast` values, all wrong** (12.4 stored vs 15.89 computed on `chill`).
    Exactly the stale claim the validator exists to catch, so the data was corrected, not the assertion.

## Open questions / risks carried
- `inputs/sample-interview-question.md` was missing (A-01); the authored file is a stand-in.
- Local embedder is **Experimental**; BM25 carries exact-term recall. Measured, not assumed.
- **MongoDB, Azure AI Search, Azure Blob and Azure OpenAI adapters are not implemented.** The selectors
  are read and honestly reported, and Redis works, but those four are labels without adapters behind
  them. Labels are honest, not aspirational.
- Bot 3's fence and isolation are structural; its *prompt-level* resistance to injection is not proven,
  because proving it needs a live model. The system prompt states that fenced text is data and the
  browser revalidates regardless, but "the model obeyed" is not something this repo can assert.
- Retrieval cannot decide answerability (BM25 always returns top-k); refusal must live in the prompt
  layer. This is pinned by a test so nobody "fixes" it with a score threshold.

## Pointers
`docs/adr/` per phase; `docs/14-decision-log.md` for the full table.

## How to resume
Read `AGENTS.md` → this file → `docs/00-plan.md`. Then run:
`npx vitest run` and `.venv\Scripts\python.exe -m pytest services/ai/tests -q`
to confirm the tree is green before starting the next task.