# ADR-0011: React as a progressive enhancement over the prerendered HTML

- **Status:** Accepted
- **Date:** 2026-10-03
- **Supersedes:** the "vanilla TS, no framework" line in AGENTS.md

## Context

`scripts/build_static_site.py` prerenders `dist/index.html` from `content/profile.json`. It is the
SEO artifact, the no-JS artifact, and the 2D fallback — all three come from one file, covered by
32 Python tests. The interactive layers on top (chat UI, model switcher, scenes) are component-heavy
and were going to be built by hand otherwise.

The gateway serves the site with a strict CSP (`services/gateway/src/middleware/security.js`):

```
script-src 'self'          <- no 'unsafe-inline', no third-party
style-src  'self' 'unsafe-inline'
```

`script-src` is strict because model output is untrusted and visitor API keys live in the browser. An
inline script is a single point of failure for both. This is load-bearing: a 4-mutation gate in the
test suite deliberately weakens the policy and requires the tests to catch it.

## Options considered

**Next.js.** Rejected. The App Router inlines bootstrap/runtime scripts into the HTML, which requires
either `'unsafe-inline'` or a per-request nonce. Nonces are incompatible with static pre-rendering, and
static pre-rendering is the entire basis of the SEO and no-JS guarantees here. It would also add a
second Node server alongside the gateway on `:8082`. It fails the CSP this repo has already hardened.

**React owning the whole page** (Vite emits `index.html`, generator retired). Rejected. It requires
deleting or rewriting the 32 prerender tests and discarding a working, tested no-JS artifact, to gain
an SPA. For a portfolio whose value includes working without JavaScript, that is a bad trade.

**React layered on the generated HTML.** Accepted.

## Decision

`build_static_site.py` keeps sole ownership of `dist/index.html`. It emits `<div id="root"></div>`
immediately before the existing `<script type="module" src="/assets/main.js">` tag. Vite builds
**only** the JS:

- `rollupOptions.input` points at `src/main.tsx`, bypassing Vite's HTML pipeline entirely.
- `emptyOutDir: false` — Vite's default would delete the generator's `index.html` and `site.css`.
- `publicDir: false` — the resume PDF is copied by the Python generator; letting Vite copy it too
  duplicated the file inside the assets directory.
- `outDir` is `new URL('./dist/assets', import.meta.url)`. A relative URL resolves against the
  *config file's* directory, so `'../dist'` silently emitted the bundle into `apps/dist`, outside the
  served tree, while still reporting success. This is now asserted by a test.

The result is one external module script and zero inline scripts, so the CSP is unchanged.

`src/main.tsx` mounts defensively: if `#root` is absent it warns and returns rather than throwing,
leaving the prerendered page fully intact. React never calls `replaceChildren()` on the document.

## Consequences

- `AGENTS.md` line 53 amended from "vanilla TS, no framework" to "React (enhancement layer only)".
- Two new invariants are gated: `typecheck` (new, `tsc --noEmit`) and `build` (generator + bundle).
- The CSP is now asserted against the *built artifact*, not just the middleware unit. If a build
  change emits an inline script, 8 tests fail instead of the enhancement dying silently in a browser.
- **Unverified in a browser.** No E2E or a11y suite exists yet, so "React mounts without console
  errors" is not yet demonstrated. `npm run dev` is still unimplemented. The Three.js scenes, chat
  UI, and model switcher are not written; `Enhancement.tsx` is a WebGL capability probe, and it says
  so in its own UI copy rather than claiming a scene exists.

## Update — browser verification (later the same day)

The "unverified in a browser" line above is now **closed**. `tests/e2e/` serves the built `dist/`
behind the gateway's own `securityHeaders()` and drives it with Playwright:

- **The production CSP does not block the bundle.** Chromium is given the real
  `script-src 'self'` header (asserted present, and asserted *not* to contain `unsafe-inline`), and
  the test fails if the console reports any CSP violation or if `#root` does not receive React's
  output. This was the specific risk that made Next.js unacceptable, and it is now measured rather
  than assumed.
- **The no-JS guarantee is tested**, in a context with `javaScriptEnabled: false`, including that
  `#root` stays *empty* — if content appeared there with JS off, something would be leaking into the
  inert path.
- **axe-core reports zero WCAG A/AA violations.** This test was verified to bite by planting a
  low-contrast `--muted` token, which axe reported as `color-contrast (serious)` across 25 nodes.

A separate honest note: one resume-link test timed out on a `href$=".pdf"` selector that demonstrably
matches the element in a standalone script. The assertion was rewritten to check the href value, but
**the root cause was not diagnosed** and is recorded in `docs/PROGRESS.md`.