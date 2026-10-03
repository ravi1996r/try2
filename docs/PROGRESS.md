# PROGRESS

**Current phase:** Phase 1 — Foundations and walking skeleton (backend vertical slice)
**Last full test run:** `npx vitest run` → **174 passed / 174** (5 files, 6.98s);
`pytest services/ai/tests` → **51 passed** (1.50s). Total **225 tests, 0 skipped, 0 failing.**
**Working tree:** clean as of the last commit

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
| 1.11 | Express server + `/v1/chat/stream` SSE endpoint | **next** |
| 1.12 | Python AI service (FastAPI) exposing retrieval | **next** |
| 1.13 | End-to-end: browser → gateway → AI service → provider | pending |
| 1.14 | `verify:fast` / `verify` runner scripts | pending |
| 1.15 | gitleaks config + secret-leak scan | pending |
| 1.16 | Security-header unit tests | pending |
| 1.17 | Phase 1 report | pending |

## Next three tasks
1. Express app with SSE `/v1/chat/stream`, wiring config → rate limit → events → Model Gateway.
2. Python FastAPI service exposing `POST /internal/v1/retrieve` over the hybrid index.
3. Integration test proving one request streams end-to-end and cancels upstream.

## Real bugs caught by tests (recorded per rule 1.4)

1. `missingKeysFor` read only `config.secrets`, silently skipping `OPENROUTER_MODEL` / `LLM_BASE_URL`.
2. Disk `KeyValueStore` never hydrated from disk — persistence looked fine, lost everything on restart.
3. Deleted keys resurrected on restart (stale seed object re-serialised).
4. `::ffff:127.0.0.1` labelled `invalid` instead of `loopback` (character guard ran before mapped check).
5. Gemini routing matched lowercase `generateContent`; real method is `streamGenerateContent`.
6. `_load_vectors` selected a `text` column from `chunk_meta`, which does not have one.
7. `_WORD_RE = [a-z0-9]+` dropped leading capitals, so "Quick" tokenised to "uick".
8. `FAKE_MARKER` conflated header name with header line → `ERR_INVALID_HTTP_TOKEN`, suite hung 320s.
9. Two suites bound port 8090 simultaneously → real `EADDRINUSE`; fixed with per-worker port offset.

## Open questions / risks carried
- `inputs/sample-interview-question.md` was missing (A-01); the authored file is a stand-in.
- Local embedder is **Experimental**; BM25 carries exact-term recall. Measured, not assumed.
- Azure OpenAI, Redis, MongoDB, Azure AI Search, Azure Blob adapters are **not implemented** —
  Redis is scaffold-only behind an injected client. Labels are honest, not aspirational.
- Retrieval cannot decide answerability (BM25 always returns top-k); refusal must live in the
  prompt layer. This is now pinned by a test so nobody "fixes" it with a score threshold.

## Pointers
`docs/adr/` per phase; `docs/14-decision-log.md` for the full table.

## How to resume
Read `AGENTS.md` → this file → `docs/00-plan.md`. Then run:
`npx vitest run` and `.venv\Scripts\python.exe -m pytest services/ai/tests -q`
to confirm the tree is green before starting the next task.