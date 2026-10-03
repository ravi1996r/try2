# Decision log

Chronological record of decisions taken while implementing phases. Each entry states the options,
the choice, and what it costs. See `docs/11-adr-0011-react-enhancement.md` for the full write-up.

## D-001 — React over the prerendered HTML, not Next.js

**Date:** 2026-10-03 · **Status:** Accepted

**Decision.** Layer React 19 + Vite 6 + Tailwind 4 + shadcn-ready `components.json` on top of the
Python-generated `dist/index.html`. The generator keeps sole ownership of the HTML; Vite emits only
`dist/assets/main.js`.

**Why not Next.js.** Its App Router inlines bootstrap scripts, which forces `'unsafe-inline'` or a
per-request nonce. Nonces are incompatible with static pre-rendering, and static pre-rendering is
what the SEO and no-JS guarantees rest on. It would have forced a concession on the exact CSP this
repo hardened and mutation-tests.

**Why not React owning the page.** Would require discarding a working, 32-test-covered no-JS artifact.

**Cost / what this changes.** Amends the AGENTS.md line "vanilla TS, no framework" (line 53) to
"React (enhancement layer only)". Adds `typecheck` and a real `build` to the gate.

**Cost / what this does NOT buy.** No scene, no chat UI, no model switcher, no browser-direct
adapters. `Enhancement.tsx` is a WebGL capability probe whose own copy says the scene is not built
yet. Not verified in a browser — no E2E or a11y suite exists.

**Cost / known trouble.** Two dependency conflicts had to be resolved to get here:
`@vitejs/plugin-react@6` requires Vite 8 (pinned to `^4.3.4` for Vite 6), and `vitest@2` pinned Vite 5
while `apps/web` needed Vite 6, producing two Vite copies and structurally incompatible plugin types
(both workspaces moved to `vitest@^3`, then `npm dedupe`). Both are dependency facts, not guesses.

## D-002 — Assert the CSP against the built artifact

**Decision.** The "no inline `<script>`" invariant is tested against real `dist/index.html` rather
than only the middleware unit. The gate runs `build` before `test:unit` so these are not vacuous.

## D-003 — A supervisor owns all four dev processes, and `dev` reports a real exit code

**Decision.** `npm run dev` starts web + gateway + AI service + fake providers from one parent,
checks every port first, and exits non-zero if any child dies.

**Why one parent.** With four separate shells, a failure leaves three orphans holding ports, and the
next `npm run dev` then refuses to start. That refusal is correct, but it reads as a bug. One Ctrl+C
tears down everything.

**The bug this decision fixes.** The first version returned from `main()` right after spawning, so
the runner printed **`PASSED: dev`** while the web service was crashing. A gate reporting success on
a broken stack is exactly what AGENTS.md forbids. `main()` now stays pending and resolves with the
exit code that reflects *why* it stopped.

**Cost / known limits.** `dev` is still not covered by an automated test — it is verified by running
it and probing all four ports, not by a regression test. The port logic itself *is* tested (7 tests
binding real sockets).

## D-004 — The dev server serves the generated HTML via a plugin

**Decision.** A dev-only Vite plugin reads `dist/index.html`, repoints `/assets/main.js` at
`/src/main.tsx`, and serves `/assets/*` and `/resume/*` from `dist/`.

**Why it was needed.** Vite's dev server looks for an `index.html` in its own root. There isn't one,
because Python owns it. Without this, `npm run dev` served **404** on `/` while the other three
services came up fine — which reads as "the front end is broken" when nothing was wired.

**Known, accepted.** Dev HTML contains one inline script: Vite's React Fast Refresh preamble,
injected by `transformIndexHtml`. `script-src 'self'` would block it, but the dev server sends no
CSP, so it runs. Production `dist/index.html` has **zero** inline scripts, which *is* asserted. The
preamble was not disabled to "fix" this, because removing it would silently break HMR.

## D-005 — Hand-rolled lint rules instead of ESLint

**Decision.** `scripts/lint.mjs`: 5 rules, zero dependencies, over `apps/web/src`.

**Why.** Every rule corresponds to a defect that actually occurred here, or to an invariant whose
violation would be silent — `no-inline-script` (the CSP), `no-dangerously-set-innerHTML` (model output
is untrusted). ESLint would be real dependency surface that still would not have caught these.
Revisit if the rule set outgrows one file.

**The bug this decision found.** The first `no-trailing-whitespace` rule used `/\s$/`, which matches
the `\r` of a CRLF line ending. Every file reported ~100 phantom violations on Windows, so the gate
would have failed on a clean checkout. Fixed by stripping `\r` before testing. 4 of 5 rules were then
verified by planting real violations.

## D-006 — Pin requirements from the installed venv, not from memory

**Decision.** `services/ai/requirements.txt` pins every direct and transitive dependency at the
version currently installed, with a short WHY per group.

**Why.** The file did not exist, so the fresh-clone command in AGENTS.md
(`pip install -r services/ai/requirements.txt`) failed outright.

**Honesty note.** `sniffio` was initially pinned, then removed: `pip show sniffio` reported
"not found", so the pin was a guess. Verified the rest with `pip install --dry-run`.

## D-007 — E2E serves `dist/` behind the gateway's real `securityHeaders()`

**Decision.** `tests/e2e/static-server.mjs` serves the built artifact and imports
`securityHeaders` directly from `services/gateway/src/middleware/security.js`.

**Why the real headers, not a copy.** A duplicated CSP is a second source of truth that drifts, and a
policy only the test server enforces is worthless. Importing it means tightening the gateway's policy
automatically tightens what the tests enforce.

**Why `dist/` and not the Vite dev server.** The dev server serves a Fast Refresh preamble and no CSP
at all, so a dev-only suite could not detect the one failure that matters — the production CSP
blocking the production bundle. That is the exact risk that disqualified Next.js, so it is now
measured rather than assumed: the test asserts the header is present, asserts it lacks
`unsafe-inline`, and fails on any console CSP violation.

**Verified to bite.** The a11y test was checked by planting a low-contrast `--muted` token; axe
reported `color-contrast (serious)` across 25 nodes and passed again after the revert. The generator
was confirmed byte-identical afterwards (`git diff` empty).

**Cost.** E2E needs Chromium; a machine without `npx playwright install` fails with a launch error
rather than skipping. That is deliberate — a silent skip would report green while testing nothing.

## D-008 — One test was wrong, and changed for a stated reason

**Decision.** `tests/tooling.test.js` asserted that `test:e2e` exits 1 with "NOT IMPLEMENTED". Now
that the Playwright suite exists, that assertion was testing a stale fact and failing the gate for the
wrong reason. The example task moved to `perf:local`, which genuinely is not implemented.

**Why this is not rule 4 being bent.** The test's *intent* — an unimplemented task must fail loudly —
is untouched. Only the example changed. Recorded here as AGENTS.md requires.

## D-009 — Cross-process integration tests boot real processes

**Decision.** `tests/integration/` starts the fake providers, the Python AI service and the gateway
as three child processes on ports 18080/18082/18090, drives a real `POST /v1/chat/stream`, and tears
everything down. Separate vitest config (`vitest.integration.config.js`) and task
(`npm run test:integration`).

**Why real processes and not more mocks.** Everything the project had tested so far stubbed the hop
to the Python service with an injected `prepareTurn`. Every layer could be individually correct and
the chain broken — which is exactly what "partial" meant for task 1.13. The `sources.length > 0`
assertion can only pass if the gateway reached the AI service *and* that service queried a SQLite
index built from `profile.json`.

**Three environment mistakes this surfaced, all real:**
- The fake provider adds `FAKE_PORT_OFFSET` (from `VITEST_WORKER_ID`) to every port so parallel unit
  suites don't collide. That is correct for unit tests and wrong here, because the gateway is
  configured with **absolute** ports — the offset silently pointed it at nothing. Surfaced as
  `EADDRINUSE` on 18100 = 18090 + 10. Pinned to `0`.
- `PORTFOLIO_LOG_LEVEL=warning` was rejected by the gateway's own config validation
  (`debug|info|warn|error`). The config guard working as designed caught a bad value in the harness.
- One assertion expected the literal word `fake` in the provider label; the gateway actually reports
  `local (openai-compatible)`. The assertion now checks for `local`, which is the property that
  actually matters: it proves the gateway is not silently reaching a paid provider.

**Cost.** Adds ~3s to `verify` and requires a Python venv. Tests are excluded from the unit config so
`verify:fast` stays fast. Teardown was verified to leak neither processes nor ports.

## D-010 — The integration test file carries a `secret-scan: allow` marker

**Decision.** `tests/integration/chat-flow.test.js` is exempt, with the justification inline.

**Why it was needed.** The credential-rejection test sends an OpenAI-shaped string, because a test
sending `not-a-key` would pass without exercising the pattern the gateway actually looks for. The
secret scanner correctly flagged it. That is the scanner working, not a false positive — so the
exemption is stated once at the top of the file, exactly as `tests/tooling.test.js` does.

**Note on a scanner quirk worth knowing.** The scanner's own *output* contained the matched pattern,
so redirecting it to a file inside the repo (`it-out.txt`) produced a second finding pointing at the
log. Logs must be written outside the working tree; they are now written to `%TEMP%`.

## D-011 — Every declared task is implemented; `NOT_YET` is empty but retained

**Decision.** `test:live`, `evals:live`, `perf:local`, `load`, `data:reset`, `index:rebuild` and
`traceability` all now run. The `NOT_YET` map is empty and its stale entries removed.

**Why remove them rather than leave them.** `build`, `lint`, `test:live`, `evals:live`, `perf:local`
and `load` each carried a reason string that had become false — including "no linter is configured
yet" while a linter was running in the gate. They were harmless (`TASKS` is checked first) but a
runner that lies about its own state is the exact failure mode the file exists to prevent.

**Why the map is kept.** The runner's contract is "declared but unimplemented => exit 1 with a named
reason, never a silent success". Deleting the map would remove the ability to express a newly added,
unwritten task. It is the reporting mechanism, not a list of debt.

**Test consequence.** Two tests referenced the old behaviour. Both were changed for stated reasons:
the `--list` test now asserts that NO task claims to be unimplemented, and the "an unimplemented task
fails loudly" test was replaced with a stronger invariant — every npm script pointing at the runner
names a task that exists. With no unimplemented task left, the old mechanism cannot be exercised end
to end, and the replacement still catches the failure that would actually bite a user.

## D-012 — `load` and `perf:local` measure against the local fake and assert no threshold

**Decision.** Both harnesses report measurements and exit 0 on correctness. Neither invents a pass
line, and both print an explicit SCOPE note.

**Why no threshold.** No SLO has been agreed for this project. A "must exceed 55 FPS" gate would be a
number manufactured to make a gate exist. Correctness (no errors) is the only defensible signal until
someone actually agrees a target.

**A bug worth recording.** The first `perf:local` reported `mean FPS 1000.0`, because it divided the
frame count by a hardcoded `1000` instead of elapsed time. The real figure was ~59.7. A fabricated
number produced by dividing by the wrong constant is precisely what AGENTS.md rule 3 forbids, and it
would have been published if I had not checked the frame times against the FPS. It now sums the
measured deltas, and FPS and frame-time percentiles derive from the same observations.

## D-013 — Contact details are served by the gateway, never bundled

**Decision.** Added `GET /v1/contact/reveal` to the gateway, filtered to fields where
`public === true && render === 'reveal'`, rate limited with the existing limiter. The browser hook
fetches on an explicit click.

**Why an API rather than a constant.** The generator deliberately omits these values from the HTML
(32 tests assert their absence). Importing them into the bundle would have put a phone number in
`main.js` and silently undone that decision.

**Why the filter needs two conditions.** `render: 'link'` fields are already visible in the HTML, so
sending them adds nothing, and `public: false` fields must never be served regardless of rendering.
Three integration tests assert the returned key set exactly equals the profile's reveal-field set.

**Two bugs this introduced, both caught by the gate rather than by reading:**
- `rateLimiter` was referenced inside `mountRoutes` but only destructured inside `mountChatRoutes`.
  The gateway crashed with `ReferenceError` on first use, and because the test suite precomputed one
  successful chat turn in `beforeAll`, the tests that reused it PASSED while every test making a live
  request failed with `ECONNRESET`. A cached fixture disguised a crashed server as a partial pass.
- Two `describe` blocks each booted their own stack, and the second `beforeAll` raced the first
  `afterAll`'s teardown: its health probe saw the dying process still listening, reported healthy, and
  every subsequent request failed. One file-level stack fixed it.

## D-014 — The theme list has exactly one source of truth

**Decision.** The browser's theme ids equal the gateway's `/v1/config` `themes` array. A test parses
both declarations and compares them.

**Why this test exists.** During the frontend work the theme list was defined twice with DIFFERENT
names (`default`/`midnight`/`paper`/... in the hook, `chill`/`cyberpunk`/`fantasy`/`retro`/`modern` in
the gateway). Nothing failed. The page simply offered themes with no CSS behind them — a silent
product bug. The test now fails on any drift, and it was verified to bite by renaming an id (3 of 3
failed) before being restored.

**Also asserted:** every theme declares all six tokens, so no theme inherits a base background and
silently creates an unverified contrast combination; and the hook's default equals the first entry,
which has a CSS block, so the page never flashes the wrong palette before hydration.

## D-015 — `/v1/prepare` existed in the header comment but was never routed

**Decision.** Implemented `POST /v1/prepare`: context assembly only, no model call. `mountRoutes`
now takes `prepareTurn` as a second argument, and `server.js` constructs the client once and passes it
to both `mountRoutes` and `mountChatRoutes`.

**Why it mattered.** The browser-direct (BYOK) path is documented in the gateway's own file header and
in ADR-0006, but no route existed. Any implementation of the model switcher would have had to invent
its own context assembly, and the two paths would then drift.

**Why one shared client.** `mountRoutes` is called before `mountChatRoutes`, so `prepareTurn` could not
be read off `ctx`. Rather than reorder startup (which changes when the AI client is constructed), it
is injected once and passed to both — so `/v1/chat/stream` and `/v1/prepare` cannot assemble context
differently. If they could, an answer would change purely based on who paid for the model call.

**The credential guarantee is asserted, not assumed.** Four integration tests: `/v1/prepare` refuses
a key in the body and an `Authorization` header, and the *entire raw response text* is asserted not to
contain the submitted value — so a field nobody remembered to sanitise still fails the test. The
success path also asserts the response carries **no** `chunks`, `messages` or `prompt`, because
shipping retrieval scaffolding to the browser would undo what the canary guard hides.

## D-016 — Three.js is code-split behind the WebGL probe

**Decision.** `scene/Scene.ts` imports three.js statically, but `Enhancement.tsx` imports that module
with a dynamic `import()` only after `getContext` confirms WebGL.

**Measured result.** `main.js` is 237 kB and a separate `Scene.js` chunk is 465 kB. A device without
WebGL never fetches the 465 kB. The dynamic import is the whole reason that split exists; a static
import would have pulled it into the entry chunk for everyone.

**Reduced motion is a real branch, not a slower animation.** `prefers-reduced-motion: reduce` renders
exactly ONE frame and reports `kind: 'reduced-motion'`, which the component turns into distinct UI
copy. Claiming "3D scene running" while nothing animates would be a false claim in the interface.

**Verified, not assumed.** `npm run perf:local` measures the scene actually rendering: 60.0 FPS mean,
16.70 ms p50/p95, 0 frames over 50 ms, 9.5 MiB heap, Intel UHD via ANGLE.

## D-017 — A second `role="status"` broke an existing E2E test, and the test was right

**Decision.** Scoped the existing status test to `.first()` and added two new tests for the switcher.

**Why the test was right.** Adding the model switcher's cost label introduced a second live region, so
`getByRole('status')` became ambiguous and failed. Two live regions is correct here — the scene status
and the cost label are both things that change and that the visitor must notice. The bug was in the
ambiguous query, not in the markup.

**The new tests turn prose into assertions.** The panel says in text that the key is "held in this tab
only". The E2E test types a realistic key, then reads `localStorage` and asserts the value is absent —
so a future edit that persists it fails the gate instead of quietly breaking a stated promise. It also
asserts `type=password` and `autocomplete=off`, because a BYOK field that autofills to disk is the most
common way this panel would leak a credential.

**axe still reports zero WCAG A/AA violations** with the chat panel, switcher and scene added.

## D-018 — The browser-direct path dispatches; the key never leaves the browser

**Decision.** `lib/browserChat.ts` calls `/v1/prepare` for context (no credential), then calls the
visitor's chosen provider directly and streams the result. `ModelSwitcher` publishes its settings
through a **ref**, not state, so the key never enters the render tree, a devtools snapshot, or an
error boundary dump.

**How the guarantee is tested, not asserted.** An E2E test types a realistic key, selects the browser
path, captures every request to `/api/v1/*` **including its POST body**, and asserts the key appears
in none of them — while also asserting `/v1/prepare` *was* called. Asserting only the absence would
also pass if the feature were broken and made no requests at all. A second test asserts the raw
`localStorage` contents after typing, so "held in this tab only" cannot silently become "saved".

**Provider errors never echo the body.** Only the HTTP status and a fixed sentence reach the visitor,
because a provider error payload can contain the key. 401/403 and 429 get the one actionable hint.

## D-019 — Two E2E infrastructure bugs, and my first diagnosis was wrong

**The symptom.** Three chat tests failed with the panel stuck on its `…` placeholder for 22–35s.

**My first guess was wrong.** I assumed the proxy's `await upstream.arrayBuffer()` was buffering the
open SSE stream and changed it to pipe. That change is *correct* and stayed — buffering genuinely
would break streaming — but it was **not** the cause.

**The actual cause**, found by probing one layer at a time instead of reasoning: direct to the gateway
returned `200` with 3918 bytes; through the proxy it returned **404**. The page calls
`/api/v1/chat/stream` so the request stays same-origin (CSP `connect-src 'self'`, no CORS preflight),
but the gateway's real route is `/v1/chat/stream`. The proxy forwarded the `/api` prefix verbatim and
every single call 404'd.

**Lesson worth recording.** I guessed, wrote a plausible-sounding fix, and believed it until a test
disagreed — then guessed *again*. Measuring each layer separately (gateway → proxy) located it in two
commands. The first fix was a real improvement that happened not to be the bug; had I not re-run the
test I would have reported it as fixed.

**Third, unrelated failure:** after both fixes, two tests still failed to find the radio. The bundle
was **stale** — I had added the control without rebuilding. `npm run build` put it in immediately.
Worth noting because the suite correctly refused to pass against an outdated artifact.

**Result:** 11 E2E tests pass, and the chat tests dropped from 22–35s timeouts to **1.2–2.1s**, which
is itself evidence the path went from "hangs" to "streams".