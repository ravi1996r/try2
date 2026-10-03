// secret-scan: allow
//
// WHY this file is exempt: ONE string below is a DELIBERATE FIXTURE shaped like an OpenAI key. It
// exists so the panel's promise ("held in this tab only") can be proven against a realistic input --
// a test asserting on the literal "abc" would pass without ever matching what the scanner hunts for.
// It is not a credential: it is a typed sentence, it never leaves the test browser's localStorage
// (which is exactly what the test asserts), and the page never sends it anywhere.
//
// This is the scanner working correctly. Any OTHER key-shaped string in this file is a real finding
// that needs a human.
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * WHY this suite exists: everything else in the gate reads files off disk. Until now, NOTHING had
 * loaded the site in a real browser, so "React mounts" was an assumption. The highest-value
 * assertion here is the first one -- the production CSP must not block the production bundle, and
 * only a real browser's console can tell us that.
 */

/** Collects every console message and page error for the life of a test. */
function watch(page) {
  const messages = [];
  const errors = [];
  page.on('console', (m) => messages.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(e.message));
  return { messages, errors };
}

test.describe('production artifact in a real browser', () => {
  test('the CSP does not block the bundle: no CSP violations, and React mounts', async ({ page }) => {
    const { messages, errors } = watch(page);
    const response = await page.goto('/');

    expect(response?.status(), 'the generated index.html must serve 200').toBe(200);

    // WHY assert the header is actually present before judging its effect. Without this, a server
    // that served no CSP at all would also produce zero violations, and the test would pass for the
    // wrong reason -- exactly the false green this project treats as a defect.
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp, 'the gateway CSP must be applied to the site').toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

    // The prerendered content must be present BEFORE anything else: this is the no-JS guarantee.
    await expect(page.locator('h1')).toBeVisible();

    // React's mount proof: the enhancement renders inside #root.
    await expect(page.getByTestId('enhancement')).toBeVisible();

    const violations = messages.filter((m) => /Content Security Policy|Refused to/i.test(m));
    expect(violations, `CSP blocked something:\n${violations.join('\n')}`).toEqual([]);
    expect(errors, `uncaught page errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the prerendered page is complete with JavaScript disabled', async ({ browser }) => {
    // WHY this is a separate context: `javaScriptEnabled: false` cannot be toggled on an existing
    // page, and this is the single most important guarantee in the project -- a portfolio that
    // needs JS is not a no-JS portfolio.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');

    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('main#main')).toBeVisible();

    // The navigation and footer are generated content, not React, so they must survive.
    await expect(page.locator('nav.sections')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();

    // WHY assert React's mount point is EMPTY here: with JS off, nothing should have rendered into
    // it. If content appeared, something server-side is leaking into a path meant to be inert.
    await expect(page.locator('#root')).toBeEmpty();

    await context.close();
  });

  test('the enhancement states its own status instead of failing silently', async ({ page }) => {
    await page.goto('/');
    // WHY `.first()` rather than getByRole('status') alone: the page now has TWO live regions -- the
    // scene status and the model switcher's cost label -- which is correct (both are things that
    // change and matter). The status test must target the scene's specifically, and the cost label is
    // covered by its own test below. Without this scoping the query is ambiguous and fails.
    const status = page.locator('[role="status"]').first();
    await expect(status).toBeVisible();

    // WHY assert on honesty rather than a specific string: the copy is expected to change, but it
    // must always say which state it is in. AGENTS.md forbids silent fallbacks, and a spinner that
    // never resolves is the UI equivalent of one.
    const text = (await status.innerText()).toLowerCase();
    expect(
      /webgl|3d|scene/.test(text),
      `status text must report the real state, got: "${text}"`,
    ).toBe(true);
  });

  test('the model switcher states cost and where the visitor data goes', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Provider')).toBeVisible();

    // WHY assert the cost label rather than trusting the JS: this is the project's honesty
    // requirement made visible. A remote provider MUST say the question leaves the machine, and a
    // local one MUST say nothing does. If a future edit hardcodes "free" next to a paid provider,
    // this fails.
    const cost = page.locator('.switcher-cost');
    await expect(cost).toBeVisible();
    await expect(cost).toHaveAttribute('data-remote', 'true');
    await expect(cost).toContainText(/billed|goes to this provider/i);

    // WHY switch to the local provider and re-assert: proving the label is not hardcoded requires
    // that it changes when the selection does.
    await page.getByLabel('Provider').selectOption('ollama');
    await expect(cost).toHaveAttribute('data-remote', 'false');
    await expect(cost).toContainText(/free/i);
    await expect(cost).toContainText(/nothing leaves your machine/i);
  });

  test('the API key field is a password input that is never persisted', async ({ page }) => {
    await page.goto('/');
    const key = page.getByLabel('API key');
    await expect(key).toBeVisible();
    // WHY assert type=password: an API key rendered as plain text is shoulder-surfed by anyone
    // looking at the screen, and it is the single most common way a BYOK form leaks a credential.
    await expect(key).toHaveAttribute('type', 'password');
    // WHY assert autocomplete=off: a browser that autofills and persists a provider key would store
    // it on disk, which is exactly what this panel promises never to do.
    await expect(key).toHaveAttribute('autocomplete', 'off');

    // WHY assert localStorage is untouched after typing: "held in this tab only" is a promise the
    // UI makes in prose, and this turns it into something a regression can break.
    await key.fill('sk-test-value-not-a-real-key');
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    expect(stored).not.toContain('sk-test-value-not-a-real-key');
  });

  test('the site path streams a real answer into the transcript', async ({ page }) => {
    await page.goto('/');
    const input = page.getByLabel('Your question');
    await input.fill('What has he built with Gen-AI?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    // WHY assert on the TRANSCRIPT and not just a network response: a 200 with zero tokens would pass
    // a status check while showing the visitor nothing. The answer text must actually appear.
    const answer = page.locator('.chat-answer').first();
    await expect(answer).toBeVisible({ timeout: 20_000 });
    await expect(answer).not.toBeEmpty();

    // WHY require more than the ellipsis placeholder: the panel renders '\u2026' while waiting, so an
    // assertion that only checks non-empty would pass before a single token arrived.
    await expect(answer).not.toHaveText('\u2026', { timeout: 20_000 });
  });

  test('choosing the browser path sends no credential to the site gateway', async ({ page }) => {
    const toSite: string[] = [];
    // WHY capture the BODIES, not just the URLs: the threat is a key in a JSON body on a request that
    // looks perfectly normal by URL alone. Only inspecting request data can catch that.
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/')) {
        toSite.push(`${req.method()} ${req.url()} ${req.postData() ?? ''}`);
      }
    });

    await page.goto('/');
    await page.getByLabel('Provider').selectOption('openai');
    await page.getByLabel('API key').fill('sk-browser-path-must-not-be-forwarded');
    await page.getByRole('radio', { name: 'My own model' }).check();

    await page.getByLabel('Your question').fill('Tell me about his work.');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    // Wait for the panel to settle: either an answer, or the provider-refused error. Both are fine --
    // what matters is the request that was made.
    await expect(page.locator('.chat-error, .chat-answer').first()).toBeVisible({ timeout: 20_000 });

    const joined = toSite.join('\n');
    expect(joined, 'the typed key must never appear in a request to this site').not.toContain(
      'sk-browser-path-must-not-be-forwarded',
    );
    // WHY assert prepare WAS called: proving only the absence of the key would also pass if the
    // feature were silently broken and made no requests at all.
    expect(joined).toContain('/api/v1/prepare');
  });

  test('refuses the browser path with an empty key instead of sending a blank credential', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('radio', { name: 'My own model' }).check();
    await page.getByLabel('Your question').fill('hello');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();

    // WHY this exact sentence: an empty-key request would otherwise reach the provider and return an
    // opaque 401, which a visitor reads as "the site is broken". The message must point at the cause.
    const error = page.locator('.chat-error');
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toContainText(/API key/i);
  });

  test('the resume download resolves', async ({ page }) => {
    // WHY assert the page actually loaded first: this test's failure mode was ambiguous. It timed
    // out waiting for a link, which reads identically whether the page failed to load or the
    // selector was wrong. Asserting the h1 first separates those two cases in the failure output.
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    await expect(page.locator('h1')).toBeVisible();

    // WHY check status rather than click it: a PDF download in headless Chromium is awkward to
    // assert on, but a 404 on the link a visitor actually clicks is a real defect.
    const link = page.locator('a[download]').first();
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute('href');
    expect(href, 'the resume link must have an href').toBeTruthy();
    // WHY assert the string rather than use a `href$=".pdf"` CSS selector: this version passed while
    // the selector version timed out, and the difference is not understood. Asserting on the value
    // tests the real contract (the link points at a PDF) and does not depend on selector subtleties.
    // The unresolved discrepancy is recorded in docs/PROGRESS.md rather than papered over.
    expect(href!.endsWith('.pdf'), `resume link should point at a PDF, got "${href}"`).toBe(true);

    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
  });

  test('has no detectable WCAG A/AA violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();

    // WHY run axe on the hydrated page: the prerendered HTML and the React enhancement are both
    // in the accessibility tree, so scanning only the static file would miss problems React adds.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const summary = results.violations.map(
      (v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.length} node(s)]`,
    );
    expect(summary, 'axe found accessibility violations').toEqual([]);
  });

  test('serves the security headers on every response', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response?.headers() ?? {};
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBeDefined();
    // WHY HSTS is asserted ABSENT: securityHeaders() adds it only in production. Asserting it here
    // would be asserting a policy this server does not have, and a test that demands the wrong
    // header is worse than no test.
    expect(headers['strict-transport-security']).toBeUndefined();
  });
});