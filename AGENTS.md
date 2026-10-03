# AGENTS.md — standing rules for this repo

Read this file first, then `docs/PROGRESS.md`, then `docs/00-plan.md`. Resume from them after any
context reset. Do not ask for approval between steps; decide, log, and continue.

## What this is
Interactive 3D portfolio for **Ravi Ranjan Prasad**. Three.js front end, Node.js gateway (`:8082`),
Python AI service (`:8080`), three chatbots, five themes. Local-first: it must run with
`APP_ENV=local`, `USE_LOCAL_FALLBACKS=true` and **zero credentials**.

## Hard rules (never break these)
1. **Priority order**: security > honesty > correctness > accessibility > performance > aesthetics > extras.
2. **Never invent personal facts.** `content/profile.json` is derived only from `inputs/`. Anything
   the resume does not state becomes a TODO in `docs/content-todos.md`, never a guess.
3. **Never claim without evidence** from this repo: a command, its output, a screenshot, a measurement.
   No "production ready", "secure", "scalable", "free", "fast" without a number behind it.
4. **Never weaken or skip a test to make a gate pass.** A test may only change if it was wrong, and
   the reason must be stated in the Phase Report.
5. **No silent fallbacks.** Not local→paid, not visitor-model→site-model, not provider→provider.
   A failure is reported with a reason and a next step.
6. **Secrets**: never read, print or commit `.env`. Visitor API keys stay in the browser. My LLM and
   search keys never reach the browser.
7. **Touch only this folder.** No `git push`, no deploys, no cloud resource creation, no global installs.
8. **Never stop to ask.** Record the decision in `docs/14-decision-log.md` and keep going.

## Commands (npm scripts; all work in PowerShell and bash)
```
npm run verify:fast     # lint + typecheck + unit + contract tests      (< 2 min target)
npm run verify          # full gate: build, unit, secret scan, CSP mutation,
                        # env drift, CROSS-PROCESS integration, E2E + a11y
npm run test:integration # gateway -> Python AI service -> fake provider, real processes
npm run test:e2e         # Playwright + axe against dist/ behind the real CSP
npm run dev             # start web + gateway + ai service (+ fake providers)
npm run build           # production build of apps/web
npm run test:live       # opt-in; needs ALLOW_LIVE_TESTS=1 and real keys
npm run evals:live      # opt-in quality evals on the real model
npm run perf:local      # FPS/memory on real GPU hardware (manual)
npm run load            # load test against the fake provider
npm run data:reset      # wipe local data/ state
npm run index:rebuild   # rebuild the local retrieval index
npm run traceability    # regenerate docs/requirements-traceability.md
npm run secret-scan     # scan working tree for secret-shaped strings
```
Python tests: `./.venv/Scripts/python.exe -m pytest services/ai/tests -q` (Windows)
or `python -m pytest services/ai/tests -q` (POSIX). If the venv is missing: `python -m venv .venv`
then `.venv/Scripts/python.exe -m pip install -r services/ai/requirements.txt`.

Ports: web `:5173`, gateway `:8082`, AI service `:8080`, fake providers `:8090` (OpenAI-compatible),
`:8091` (Ollama), `:8092` (Anthropic), `:8093` (Gemini).

## Ports must be free
`npm run dev` checks 5173/8080/8082/8090-8093 and fails with a clear message rather than hanging.

## Layout
```
apps/web/            Vite + React (enhancement layer only) + Three.js scenes
services/gateway/    Node BFF: rate limits, CORS, security headers, SSE fan-out, sessions
services/ai/         Python: orchestration, RAG, ingestion, retrieval, tools
packages/contracts/  JSON Schema shared by both services (single source of truth)
content/              profile.json (+ schema), projects/*.md
ops/fake-providers/  clearly-labelled fake LLM/search servers for tests
docs/                plan, architecture, ADRs, reports, traceability
```

## Conventions
- One render-loop owner. One module per theme scene. Shared utilities only.
- **The Python generator owns `dist/index.html`.** React mounts into `#root` and may never replace the
  prerendered markup; Vite emits only `main.js`. See `docs/11-adr-0011-react-enhancement.md`.
- Strategy pattern for every external concern: business logic depends on the interface, never on
  `if (env === ...)`. Selectors live in one factory.
- Every important module carries a WHY / ALTERNATIVES / WHY NOT / TRADE-OFF comment. Keep them true.
- New code follows the priority order; if it cannot, write down why.
- Secrets are names in `.env.example` only. A test fails if code reads an env var missing from it.
- Phase reports go to `docs/reports/phase-N.md`. Update `docs/PROGRESS.md` after every task.
- Git: branch `phase-N-name`, conventional commits, merge to `main` only when `verify` is green.

## Gates (Definition of Done, every phase)
1. `verify` green, zero skipped tests.
2. Comments + docs + decision log updated.
3. `docs/requirements-traceability.md` regenerated.
4. README feature table uses honest labels: Implemented / Partially Implemented / Experimental /
   Not Implemented / Provider Dependent.
5. `docs/PROGRESS.md` updated.
6. Phase Report written to `docs/reports/`.