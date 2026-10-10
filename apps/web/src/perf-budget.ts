/**
 * Performance budgets, as data the CI gate and the browser can both read.
 *
 * WHY budgets live in a module and not in a config file the build reads: they are also needed at
 * RUNTIME, where the scene degrades on a low measured frame rate. If the gate and the runtime read two
 * copies, CI could pass a bundle the browser would then throttle.
 *
 * WHY the frame-time target is a RANGE and not one number: a 60Hz display needs 16.7ms per frame and a
 * 120Hz display needs 8.3ms. Demanding 60fps on a 120Hz panel asks for twice the work for a result the
 * visitor cannot see, so the target is a floor on frames and a ceiling on the interval.
 */

/** Gzipped size budgets in BYTES. `main` is the hero chunk; `scene` is the lazy Three.js chunk. */
export const BUNDLE_BUDGET = Object.freeze({
  main: 90 * 1024,
  scene: 130 * 1024,
  css: 12 * 1024,
});

/**
 * WHY there is no total-bundle budget: the scene chunk loads only after Web detection, so its size
 * affects the 3D path and not first paint. A single total would hide a hero regression behind an
 * unrelated scene improvement.
 */

/**
 * Core Web Vitals budgets -- the thresholds Google actually measures on.
 *
 * WHY CLS matters most here: this page prerenders its content and React mounts into it, so any layout
 * shift when the enhancement layer attaches is invisible to the developer and highly visible to a
 * visitor who was already reading.
 */
export const VITALS_BUDGET = Object.freeze({
  cls: 0.1,
  lcp: 2500,
  inp: 200,
});

/** Frame-time budget. A frame slower than this is a visible hitch, not a rounding error. */
export const FRAME_BUDGET = Object.freeze({
  minFps: 45,
  maxFrameMs: 1000 / 45,
  /**
   * How many consecutive slow frames trigger a downgrade.
   *
   * WHY not one: a single slow frame is usually a GC pause or a tab that was backgrounded. Reacting to
   * it would degrade quality on a machine that was never struggling, costing the visitor detail for
   * nothing.
   */
  consecutiveSlowFrames: 30,
  /** Cooldown after a downgrade, so quality cannot oscillate within a second. */
  cooldownMs: 4000,
});

/** Quality tiers, cheapest to most expensive. `auto` starts at `high` and degrades. */
export const QUALITY_LADDER = Object.freeze(['low', 'medium', 'high'] as const);

export type QualityTier = (typeof QUALITY_LADDER)[number];

/**
 * Decides the next quality tier from a measured frame time.
 *
 * WHY this is a pure function: it is the decision that silently changes how the site looks, and the only
 * honest way to test that is to assert on the decision directly rather than through a canvas. Every
 * branch below has a test.
 *
 * @param currentTier the tier in use now.
 * @param slowStreak  consecutive frames over budget.
 * @returns the tier to use next, or null to leave it alone.
 */
export function nextQualityTier(
  currentTier: QualityTier,
  slowStreak: number,
): QualityTier | null {
  if (slowStreak < FRAME_BUDGET.consecutiveSlowFrames) return null;
  const index = QUALITY_LADDER.indexOf(currentTier);
  // WHY stop at `low` rather than switching the scene off: a still image is still worth showing, and a
  // visitor who sees the canvas vanish has lost something they may have wanted.
  if (index <= 0) return null;
  return QUALITY_LADDER[index - 1];
}

/**
 * Scales a scene's detail for a quality tier.
 *
 * WHY detail is cut FIRST: it is the only knob that reduces fragment count without changing what the
 * object IS. Reducing motion would change the theme's identity, and dropping the canvas entirely is a
 * visible feature loss.
 */
export function detailForTier(baseDetail: number, tier: QualityTier): number {
  switch (tier) {
    case 'high':
      return baseDetail;
    case 'medium':
      return Math.max(0, baseDetail - 1);
    case 'low':
      // WHY 0 is the floor: three.js accepts 0 and renders the coarsest valid form. A negative value is
      // not clamped for you and produces degenerate geometry.
      return 0;
  }
}

/**
 * Scales rotation speed for a tier.
 *
 * WHY motion is reduced rather than removed: the theme's motion is part of its identity (see
 * scene/themes.ts), so removing it outright would make a theme unrecognisable. Scaling it keeps the
 * identity and reduces the per-frame work.
 */
export function motionScaleForTier(tier: QualityTier): number {
  switch (tier) {
    case 'high':
      return 1;
    case 'medium':
      return 0.6;
    case 'low':
      return 0.35;
  }
}

export interface BudgetReport {
  name: string;
  /** Actual gzipped bytes, or the measured value. */
  actual: number;
  budget: number;
  ok: boolean;
  /** Percentage of the budget consumed, so a failure says how far over it is. */
  usedPercent: number;
}

/**
 * Builds one report entry.
 *
 * WHY a helper rather than inline asserts in a script: the CI output should show HOW FAR over a budget
 * the build is, not merely that it is over. A developer needs to know whether to shave 2 kB or rethink
 * a dependency.
 */
export function budgetReport(name: string, actual: number, budget: number): BudgetReport {
  return {
    name,
    actual,
    budget,
    ok: actual <= budget,
    usedPercent: Math.round((actual / budget) * 100),
  };
}

/**
 * Turns a report list into the exit condition and the message.
 *
 * WHY it returns a message rather than throwing: the caller is a script that should print EVERY breach
 * and then fail once, rather than stopping at the first and making the developer fix them one run at a
 * time.
 */
export function summarizeBudgets(reports: BudgetReport[]): { ok: boolean; message: string } {
  const breaches = reports.filter((r) => !r.ok);
  if (breaches.length === 0) {
    return { ok: true, message: `all ${reports.length} budget(s) within limit` };
  }
  const lines = breaches.map(
    (r) => `  ${r.name}: ${r.actual} bytes is over the ${r.budget} byte budget (${r.usedPercent}%)`,
  );
  return {
    ok: false,
    message: [`${breaches.length} budget(s) exceeded:`, ...lines].join('\n'),
  };
}
