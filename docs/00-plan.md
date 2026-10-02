# 00 - Plan, decisions and assumptions

**Status:** in progress. This is a working document, not an approval gate.
**Owner answers applied:** fully autonomous, local-first, personal resources only, no deployment.

## 1. Attachments: what I extracted, and what was ambiguous

| File | What it gave me | Ambiguity → assumption |
| --- | --- | --- |
| `inputs/Ravi_Ranjan_Prasad_Resume.pdf` (2pp) | Name, headline, location, contact, summary, 7 skill groups, TCS Oct 2021–Present (ExxonMobil/ITChat Sep 2024–Present; Shell/Sam Oct 2021–Sep 2024), Wipro Jun 2019–Jun 2020, B.Tech Chandigarh University 2015–2019, 7 certifications | PDF text extraction lost word spacing inside bullets (`Developedandmaintainedbackendservices`). Reconstructed by reading, not guessing: every restored bullet is a verbatim resume claim. Recorded in `content/profile.json` `source_register`. |
| `inputs/Ravi_Ranjan_Prasad_Interview_Preparation_Pack.pdf` (46pp) | Verified-profile corrections (ITChat = Sep 2024; Shell = one ~3yr engagement; a ~15-month freelance gap Jul 2020–Sep 2021; a list of what is *not* evidenced) | **Not used as a content source.** The resume is authoritative. Used only to pick the Bot 1 acceptance question and to encode a "do not claim" list. The gap period and the freelance/follower detail are NOT in `profile.json`: the resume does not mention them, and adding them would be inventing content. |
| `inputs/model-switcher-reference.png` | Interaction pattern: panel with a status line ("No model set up…") + Close action, five tabs, and for Custom: explanatory paragraph, Base URL (required), Model (required), API key (optional), "Test & switch" | Used for **interaction pattern only**. No branding, wording or styling copied — see `docs/09-frontend-3d-and-themes.md`. |
| `inputs/sample-interview-question.md` | **MISSING.** Not present in `inputs/`. | **Assumption:** I wrote it, deriving the question from the pack's anchor project plus resume facts, adding no new claims. It states its own provenance and says to replace it if a different question was intended. The acceptance test reads whatever the file contains. Logged as A-01. |

### Content TODOs (things the resume does not state)
Tracked in `docs/content-todos.md`. Nothing here is invented; each is a marked placeholder.

| ID | Item | Why it is a TODO |
| --- | --- | --- |
| T-01 | `projects[]` is empty | The resume has no project section. Client engagements live under `experience[].clients[]`. The Projects section renders with an explicit notice. |
| T-02 | No metrics/percentages | The pack explicitly warns against reusing "fabricated specifics (user counts, accuracy percentages)". None exist in the resume, so none are claimed. |
| T-03 | Client names are public, client *details* are not | The resume names Exxon Mobil and Shell. The site shows the engagement and the resume's own bullets. |
| T-04 | No personal projects, portfolio links or writing | None supplied. The site does not claim any. |

## 2. Service topology and the "why not one service" position

```
Browser (Three.js + chat)
   | HTTPS, SSE
   v
Node gateway :8082  -- rate limits, CORS, security headers, sessions, SSE fan-out, cancellation
   | internal HTTP + short-lived signed token
   v
Python AI service :8080  -- orchestration, RAG, ingestion, chunking, embedding, retrieval, tools
```

**Why Node for the gateway.** It sits on the hot path for every visitor and its job is HTTP
plumbing: parsing, CORS, headers, rate limiting, SSE fan-out, abort propagation. Node's event loop
and mature HTTP stack do that with less code and lower memory than an ASGI server, and SSE is a
## 3. Positions on the section 5.7 hypotheses

| # | Question | Position | Where |
| --- | --- | --- | --- |
| 1 | Node+Python vs one FastAPI | Keep the split for isolation and existing infra; acknowledge one service is the better default for low traffic. | ADR-0001 |
| 2 | Which entities need a database | Only durability: usage/budget records. **Conversations are not persisted.** Short-term memory lives in the cache with a TTL, disclosed in the UI. | ADR-0002 |
| 3 | Chroma vs FAISS vs other | Neither. A dependency-free numpy flat index + SQLite FTS5, because per-session deletion and mandatory filters are the hard requirements and both libraries make Windows install and delete-by-filter awkward at this scale. Chroma/FAISS labelled Not Implemented. | ADR-0003 |
| 4 | Vanilla Three.js vs R3F | **Vanilla Three.js.** The Master bot needs imperative, schema-validated control and exactly one render-loop owner; R3F's reconciler adds a second, implicit ownership story for no gain here. | ADR-0004 |
| 5 | SSE vs WebSocket | **SSE.** Traffic is server→client token streaming plus a single POST; SSE gives that over plain HTTP with automatic browser reconnect and trivial proxying. | ADR-0005 |
| 6 | Browser-direct vs proxying visitor keys | **Browser-direct.** Proxying would mean handling visitor secrets and needing SSRF protection for arbitrary base URLs, while still being unable to reach a visitor's localhost. CSP `connect-src` = `'self'` + known provider hosts + loopback, widened only by an explicit flag. | ADR-0006 |
| 7 | Client-side lexical retrieval for Bot 1 | Deferred (Could). Not needed while `verify` runs zero-credential. | ADR-0007 |

## 4. Local-first backend design

One interface per concern; a factory reads validated config and returns an implementation. Business
logic never branches on an environment value. Full detail in `docs/16-local-first-backends.md`.

| Concern | Interface | Local default | Production | Status |
| --- | --- | --- | --- | --- |
| Database | `Repository` | SQLite under `data/` | MongoDB | Implemented / adapter scaffolded |
| Cache | `KeyValueStore` | in-memory (atomic TTL counters) | Redis | Implemented / adapter scaffolded |
| Vector + lexical | `VectorIndex` | numpy flat index + SQLite FTS5 | Azure AI Search | Implemented / adapter scaffolded |
| Blob | `BlobStore` | `data/blobs/` | Azure Blob | Implemented / adapter scaffolded |
| LLM (site path) | Model Gateway | `openrouter` or keyless `openai_compatible` | `azure_openai` | Implemented |
| Embeddings | `Embedder` | deterministic in-process hashed n-gram (**Experimental**) | Azure OpenAI | Implemented |
| Web search | search interface | `ddg` (**Experimental**, unofficial) | `brave` (official) | Implemented |

**Production guard.** `APP_ENV=production` refuses to start if any concern resolves to a local
engine or the fake provider, unless `PORTFOLIO_ALLOW_LOCAL_BACKENDS_IN_PRODUCTION=true`.
`USE_LOCAL_FALLBACKS=true` is a startup choice, never a runtime failover: a production backend going
down is **reported** (E2E-23), never silently replaced.

**Index compatibility.** The index records its embedder id and dimension; a mismatch fails fast and
points at `npm run index:rebuild`.

**Honest local limits.** In-memory cache and rate limits are single-process. SQLite is
single-writer. The local embedder is not a neural encoder. Local engines are for development and
demos — this is not a scalability claim.

## 5. Internal contract

Single source of truth: `packages/contracts/schemas/*.json`, validated by Ajv in Node and by
`jsonschema` in Python, with tests asserting both sides accept and reject the same fixtures.

- `POST /v1/chat/stream` — browser → gateway, answered with **SSE** (site path).
- `POST /v1/prepare` — browser → gateway → AI service, returns `PreparedTurn` (browser path).
- `POST /internal/v1/{bot}/stream` — gateway → AI service, headers `X-Request-Id`,
  `X-Session-Id`, plus a short-lived signed service token.
## 6. Data design and key classification

| Concern | Local | Production | Isolation |
| --- | --- | --- | --- |
| Durable records | `data/portfolio.db` | MongoDB `portfolio_*` | prefixed collections |
| Cache | in-process Map | Redis | `portfolio:{env}:` prefix |
| Vector | `data/index/` + FTS5 | Azure AI Search `portfolio-*` | prefixed indexes |
| Blobs | `data/blobs/` | Azure Blob `portfolio-blobs` | own container |

**Mandatory server-injected filters.** The `bot` and `session_id` filters on every vector query are
injected by the server and never taken from the client. Drop-Zone data is removed by
delete-by-filter on TTL or "clear my data", plus a sweeper (Azure AI Search has no native
per-document TTL).

**Key classification** (names only, never values; full list in `.env.example`):

| Key | Class | Note |
| --- | --- | --- |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | USE | local/dev default for the site model; server-side only |
| Azure OpenAI (endpoint, key, api-version, chat + embeddings deployments) | USE in production | personal resource only |
| Azure Blob (connection string / container) | USE in production | personal |
| Azure AI Search (endpoint, key, index) | USE | own `portfolio-*` indexes only |
| Redis (host, auth) | USE | own prefix |
| MongoDB (URI, db) | USE **only if justified** | see ADR-0002 |
| Application Insights connection string | OPTIONAL | personal resource preferred |
| `PORTFOLIO_INTERNAL_SERVICE_AUTH`, `PORTFOLIO_SESSION_SECRET` | USE | rotate; local placeholder is not a credential |
| PostgreSQL / Pinecone / S3 | **Could → labelled Not Implemented** | not wired |
| Bot Framework / Direct Line keys | **DO NOT USE** | not needed |
| `SERVICENOW_*`, `NEXTTHINK_*`, `ADF_*`, `DIRECTLINE_*`, `MICROSOFT-APP_*` | **DO NOT USE** | denylisted in config; test asserts never read/logged |
| Static IV app-level encryption | **DO NOT USE** | if ever needed: AES-256-GCM, fresh nonce per message |

**Policy flag.** Several of these resources *could* be employer-owned. Using an employer's Azure
OpenAI/Search/database for a **public personal site** risks data exposure, cost attribution and
policy breach. Section 0 states production resources are personal, and this project implements only
personal-subscription adapters. The safer pattern (separate personal resource group, spending caps,
separate indexes) is documented in `docs/13-deployment-and-cost.md`.

## 7. Chatbot designs

### Bot 1 — "About Ravi" (grounded in profile.json + content/projects/*.md)

| Aspect | Decision |
| --- | --- |
| Purpose | Answer recruiter/visitor questions about Ravi, with citations. |
| Prompt policy | Third-person by default (`PORTFOLIO_BOT1_VOICE=third\|first`). Grounded-only; a **canary token** is planted per system prompt and asserted absent from every output, log and event. Trust order: system > developer policy > user > retrieved content. |
## 8. Model switcher design

Tabs: **Site model**, Local (Ollama), Claude, OpenAI, Gemini, Custom (one-click OpenRouter preset).
"Test & switch" runs a visible stepwise probe (reachable → auth → model exists → streaming →
tools/JSON → vision) and switches only if the first four pass; otherwise it stays on the previous
model and says exactly what failed and what to do next. Capability gating: no tools/JSON → Master
disabled with a reason while the palette still works; no vision → the labelled OCR/unsupported path.
Keys are memory-only by default, never in URLs, never sent to my servers; "Remember on this device"
is opt-in with a warning, and "Forget everything" always works. Every answer carries a model badge.
**Honest copy** states exactly what goes where, and never claims "nothing is sent to us", because
Bot 1 retrieval does run server-side. Full detail and the provider capability matrix with
last-checked dates: `docs/15-model-switcher.md` and `docs/providers.md`.

## 9. Frontend / 3D plan

Vanilla Three.js + Vite + TypeScript. **One render-loop owner** (`engine/loop.ts`), one module per
theme scene, shared utilities. Themes are **data**: design tokens + scene config validated by
schema, so adding a theme is one config file plus one scene module. Transitions animate without a
reload; disposal on theme exit is tested (E2E-04). Loading progress comes from real asset-loader
events, not a timer, and the HTML hero paints before 3D finishes. `prefers-reduced-motion` yields calm
mode. WebGL failure falls back to a clean 2D portfolio with the same content and working chatbots
(E2E-03). HTML content layer is generated at build time from `profile.json` for crawlers/no-JS
(E2E-25). Deterministic test mode (fixed seed, frozen clock) is build-gated and compiled out of
production; the read-only scene-stats hook is likewise absent in production (E2E-26).

**Performance budgets (targets, to be measured — not yet measured).** Hero route JS < 500 KB
gzipped; each theme a lazy chunk; CLS ≤ 0.1; draw calls and triangles capped in CI; adaptive quality
reduces particles/post-processing/shadows on low FPS. CI enforces only hardware-independent numbers
because headless WebGL is software-rendered and its FPS is meaningless (protocol in 8.8).

## 10. Security, cost and abuse design

Priority order applied throughout: **security > honesty > correctness > accessibility > performance
> aesthetics > extras.** Atomic per-IP and per-session rate limits (never read-modify-write), request
size caps, max output tokens, global daily token budget with a circuit breaker, optional Turnstile.

SSRF-safe URL fetching: http/https only, ports 80/443 only, DNS resolved and the IP **pinned** for
the connection (defeats rebinding), loopback/private/link-local/CGNAT/multicast/unique-local/metadata
ranges blocked including IPv4-mapped IPv6 and decimal/octal/hex encodings, every redirect revalidated,
URL credentials rejected, timeouts/redirect/size caps enforced, content treated as data.

Files validated by content (magic bytes), time-boxed and size-capped, zip-bomb and path-traversal
## 11. Verification plan

| Suite | Tool | Runs in |
| --- | --- | --- |
| Unit | Vitest (Node) + pytest/hypothesis (Python) | `verify:fast` |
| Property-based | hypothesis + Vitest random sequences | `verify:fast` |
| Contract | Ajv + `jsonschema` on shared fixtures, both directions | `verify:fast` |
| Backend conformance | one suite per interface, every Implemented backend | `verify` |
| Adapter contract | fake providers in 4 wire formats + CORS toggles | `verify` |
| Integration | API, streaming, cancel, ingestion, SSRF fetcher, isolation | `verify` |
| Security | SSRF/file/XSS/abuse/isolation/BYOK corpora | `verify` |
| E2E | Playwright, IDs E2E-01…E2E-38 | `verify` |
| a11y | axe-core | `verify` |
| Perf | bundle budgets + Lighthouse CI; `perf:local` for real GPU FPS | `verify` / manual |
| Evals | deterministic vs fake provider; `evals:live` for quality | `verify` / opt-in |

`verify` must pass from a clean clone with **zero credentials and no cloud access**: the fake
providers stand in for LLM/embedding/search networks at the outer edge only, and local engines
(SQLite, memory cache, local index, local embedder) are real implementations, not mocks.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Local hashed embedder is weaker than a neural encoder | Labelled Experimental; hybrid BM25 carries exact-term recall; Azure embedder is a config switch |
| `ddg` scraping is unreliable and unofficial | Labelled Experimental in README/providers/UI; `brave` is the documented recommendation for public use |
| Piecemeal edits to nested documents produced invalid files twice | Schemas and content are generated from object literals and validated by a test |
| 38 E2E scenarios is a large surface | Implement IDs that cover real behaviour; any unimplemented ID is labelled honestly rather than stubbed to green |

## 13. Deferred

- **Could** items (theme composer, guided tour, voice input, easter eggs, full ambient sound).
- Client-side lexical retrieval for Bot 1 (hypothesis 7).
- PostgreSQL, Pinecone, S3, Chroma, FAISS: labelled **Not Implemented**.
- Deployment: docs only, per owner instruction. Nothing is deployed.

## 14. Phase map

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0 | Content + direction | profile.json + schema valid; sample question present |
| 1 | Foundations + walking skeleton | real streamed round trip + cancel; config; conformance |
| 2 | Core site (Chill, Cyberpunk) | sections, themes, fallback, pre-render, a11y |
| 3 | Bot 1 | retrieval, citations, actions, canary, limits |
| 4 | Model switcher | prepare + browser adapters + panel + CSP |
| 5 | Bot 3 | action layer, three-layer validation, undo/redo |
| 6 | Bot 2 | ingestion, SSRF fetcher, search adapters, isolation |
| 7 | Remaining themes + polish | Fantasy, Retro, Modern; perf before/after |
| 8 | Hardening + release | full security/failure suites, docs, traceability |

## Assumptions log

| ID | Assumption | Why | If wrong |
| --- | --- | --- | --- |
| A-01 | `inputs/sample-interview-question.md` was missing; I authored it from resume-grounded content | blocking on a missing file would stall the acceptance test | replace the file; the test reads it |
| A-02 | `identity.tagline` is derived from the resume summary, not quoted | hero needs a short line | edit `profile.json` |
| A-03 | `projects[]` stays empty; client engagements carry project detail | resume has no project section | add `content/projects/*.md` |
| A-04 | Resume word-spacing restored by reading, not inferred | extraction collapsed spaces | verify against the PDF; bullets are verbatim |
| A-05 | Target is Windows-native PowerShell (repo on `D:\`), WSL2 documented as alternative | repo is not in the WSL filesystem here | see README WSL2 section |
| A-06 | Client engagements shown because the resume lists them, confidential-by-default beyond resume text | respect employer confidentiality | flip `visibility` in `profile.json` |
guarded. Model output rendered as sanitised Markdown only, never raw HTML. BYOK keys never logged,
never in URLs, rejected if they arrive at my API. Strict CSP with the 5.1a `connect-src` decision.

### Degradation matrix

| Down | Visitor sees | Still works |
| --- | --- | --- |
| AI service (Python) down | "The assistant is temporarily unavailable. Please try again shortly." (retryable) | Static site, 2D fallback, all three bots' non-retrieval UI, model switcher |
| Redis down | Same message; rate limiting degrades to in-process and says so | Chat if the AI service is up; static site |
| MongoDB down | "Usage/budget records are unavailable." No silent local substitution | Everything user-facing |
| Azure OpenAI / site model down | "Site model unavailable: <reason>" and the switcher opens with the reason | Visitor's own model, static site, Bot 2/3 UI |
| Daily budget exhausted | Chat disabled with a clear message; **no further provider calls** | Static site, model switcher |
| Azure AI Search down | "Source search is unavailable; answers may be incomplete." | Chat without retrieval, static site |
| Embeddings down | Ingestion fails with a reason; existing sources still answer | Bot 1, Bot 3, static site |
| Web search down | "Web search is unavailable (outage)." Sources-only still works | Drop-Zone sources-only, Bot 1, Bot 3 |
| Context budget | `PORTFOLIO_CONTEXT_TOKEN_BUDGET` (6000 default). Retrieved chunks + current turn + recent messages; oldest turns truncated, never the whole history. |
| Retrieval | Hybrid: lexical (SQLite FTS5/BM25) + vector (local embedder), RRF merge. Citation chips carry section/project ids. |
| Actions | `show_project`, `open_contact`, `download_resume` — typed and validated. |
| Memory | Short-term per session, cache-backed, TTL 1800s, **not persisted**. |
| Guardrails | Refuses with the exact phrase "That isn't in Ravi's resume or projects." and never invents. |
| Failure states | `retrieval_failure`, `not_configured` ("Site model unavailable: no model configured"), `budget_exhausted`, `timed_out`. |
| Acceptance | `inputs/sample-interview-question.md`, ≤ ~150 words, with citations. |

### Bot 2 — "Drop-Zone" research bot

Pipeline: `Input → Loader → Parser/OCR → Normalizer → Chunker → Embedding → per-session index →
Retriever → Context → LLM → Cited answer`. Sources-only mode **never** calls a web adapter (asserted
by E2E-18: zero calls to both `ddg` and `brave`). Uploaded files, fetched pages and search results
are untrusted **data**, never instructions, and this bot has **no UI tools**. SSRF-safe fetching,
MIME-by-content validation, per-session isolation and TTL deletion. Every statement in web mode is
labelled by origin with links.

### Bot 3 — "Master" (operates the UI)

Typed, schema-validated action API only; never emits code, CSS, JS or HTML. Validated in **three**
places (AI service, gateway, browser) from one shared schema, with the browser authoritative on the
browser path. Hard floors (font scale 0.85–1.6, body contrast ≥ 4.5:1) mean the bot cannot lock a
visitor out. Full undo/redo plus always-available Reset. `open_model_settings` can only open the
panel — the schema has no field for a key, base URL or model, so filling them is structurally
impossible (E2E-32).

Event vocabulary (`meta | status | token | source | tool_call | error | done`) is identical on both
hops. Errors are `{code, message_safe, retryable, request_id}` with typed codes; `retryable` is
**data** computed by the server so the client cannot disagree with it about a 429.

**Service auth scheme:** HMAC-SHA256 signed short-lived token (`{id}.{exp}.{sig}`) derived from
`PORTFOLIO_INTERNAL_SERVICE_AUTH`, TTL default 300s. Chosen over mTLS because mTLS needs certificate
distribution for a hop that is loopback in local dev and private-network in production; a shared
secret + short TTL is auditable and has no cert lifecycle. Rejected: no auth at all (the AI service
would be an open proxy) and long-lived static tokens (no revocation).

**Cancellation** propagates browser → gateway → AI service → provider, and a test asserts the
upstream request was actually aborted (E2E-12), not merely that the UI stopped.
first-class Express response rather than something to coax out of an async framework.

**Why Python for the AI service.** Everything behind it is data work: chunking, embedding,
retrieval, parsing PDFs/DOCX, SSRF logic, evaluating answers. The Python ecosystem for that
(pypdf, numpy, hypothesis) is where the leverage is.

**Why not one service — honest position.** For *this* project the split is defensible but not free.
It costs a network hop, two deployments, two config modules and a service-auth scheme. The honest
counter-argument: a single FastAPI service could do all of it, and for a portfolio with modest
traffic that is the *better* default. I keep the split because (a) the owner already operates both
Node and Python infrastructure, and (b) the two concerns genuinely scale differently — chat
throughput and AI/RAG work have different resource profiles. **A single FastAPI service would be
better if** traffic stays low and one fewer deployment matters more than the isolation. Recorded as
ADR-0001 rather than hidden.