# PROGRESS

**Current phase:** Phase 1 — Foundations and walking skeleton
**Last `verify` result:** not yet run (no `verify` script implemented yet)
**Working tree:** clean as of the last commit

## Task checklist

| # | Task | Status |
| --- | --- | --- |
| 0.1 | Extract resume → `content/profile.json` with source pointers | done |
| 0.2 | `content/profile.schema.json` (generated, valid) | done |
| 0.3 | Author missing `inputs/sample-interview-question.md` (A-01) | done |
| 0.4 | Write `docs/00-plan.md`, `AGENTS.md`, `CLAUDE.md` | done |
| 0.5 | `.gitignore`, `.gitattributes`, `.editorconfig`, `.env.example` | done |
| 1.1 | `packages/contracts` — event + request + master-action schemas | done |
| 1.2 | Gateway typed config: denylist, fail-fast, production guard | done |
| 1.3 | Gateway config unit tests (12 passing; caught a real missingKeysFor bug) | done |
| 1.4 | Strategy-pattern backend interfaces + local implementations | **next** |
| 1.5 | Conformance suite per interface | pending |
| 1.6 | Fake provider server (OpenAI-compatible, Ollama, Anthropic, Gemini) | pending |
| 1.7 | Python AI service skeleton with matching validation | pending |
| 1.8 | Real streamed round trip + cancellation (E2E-12 subset) | pending |
| 1.9 | SSRF IP classifier + unit tests | pending |
| 1.10 | `verify:fast` / `verify` runner scripts | pending |
| 1.11 | gitleaks config + secret-leak scan | pending |
| 1.12 | Phase 1 report | pending |

## Next three tasks
1. Backend interfaces (`KeyValueStore`, `VectorIndex`, `BlobStore`, `Embedder`) with local impls.
2. Conformance suite that every Implemented backend must pass.
3. Fake provider server so the stream path can be tested without credentials.

## Open questions / risks carried
- `inputs/sample-interview-question.md` was missing (A-01). The authored file is a stand-in.
- The resume PDF's bullets lost word spacing during extraction; restored by reading. Bullets are
  verbatim claims, but worth a spot-check against the PDF (A-04).
- Local embedder is **Experimental**, not a neural encoder. BM25 carries exact-term recall.

## Pointers to ADRs
`docs/adr/` — written per phase. See `docs/14-decision-log.md` for the full table.

## How to resume
Read, in order: `AGENTS.md` → this file → `docs/00-plan.md`. Then run
`node scripts/validate-content.mjs` and `npx vitest run` to confirm the tree is green before
starting the next task.