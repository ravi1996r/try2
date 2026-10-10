/**
 * The performance budget module decides two things: whether CI passes, and how much detail a struggling
 * visitor loses. Both are silent, so both are tested as pure functions.
 */
import { describe, it, expect } from 'vitest';
import {
  BUNDLE_BUDGET,
  FRAME_BUDGET,
  QUALITY_LADDER,
  budgetReport,
  detailForTier,
  motionScaleForTier,
  nextQualityTier,
  summarizeBudgets,
} from '../src/perf-budget';

describe('quality degradation: it reacts to sustained slowness only', () => {
  it('does nothing on a single slow frame', () => {
    // WHY: one slow frame is a GC pause or a backgrounded tab. Degrading on it would cost a visitor
    // detail on a machine that was never struggling.
    expect(nextQualityTier('high', 1)).toBeNull();
    expect(nextQualityTier('high', FRAME_BUDGET.consecutiveSlowFrames - 1)).toBeNull();
  });

  it('steps down one tier after a sustained streak', () => {
    expect(nextQualityTier('high', FRAME_BUDGET.consecutiveSlowFrames)).toBe('medium');
    expect(nextQualityTier('medium', FRAME_BUDGET.consecutiveSlowFrames)).toBe('low');
  });

  it('never degrades below the cheapest tier', () => {
    // WHY it stops rather than switching the scene off: a still image is still worth showing, and a
    // visitor who sees the canvas vanish has lost something they may have wanted.
    expect(nextQualityTier('low', 10_000)).toBeNull();
  });

  it('never upgrades on its own', () => {
    // WHY: upgrading automatically would oscillate. A visitor who wants more detail asks for it, which
    // is what set_quality exists for.
    expect(nextQualityTier('low', 0)).toBeNull();
    expect(nextQualityTier('medium', 0)).toBeNull();
  });

  it('walks the ladder to the floor and stays there', () => {
    // WHY no `as` cast here: this is a .js file, and a TypeScript assertion in it is a parse error that
    // esbuild reports against whichever module it happens to be transforming -- which sent me looking in
    // the wrong file for several minutes.
    let tier = 'high';
    const seen = [];
    for (let i = 0; i < 10; i += 1) {
      const next = nextQualityTier(tier, FRAME_BUDGET.consecutiveSlowFrames);
      if (next === null) break;
      tier = next;
      seen.push(tier);
    }
    expect(seen).toEqual(['medium', 'low']);
  });
});

describe('quality degradation: what it actually reduces', () => {
  it('cuts detail before it cuts motion, and never below zero', () => {
    // WHY the order matters: detail reduces fragment count without changing the object. Motion is part
    // of a theme's identity, so it is scaled, not removed.
    expect(detailForTier(2, 'high')).toBe(2);
    expect(detailForTier(2, 'medium')).toBe(1);
    expect(detailForTier(2, 'low')).toBe(0);
    expect(detailForTier(0, 'low')).toBe(0);
    expect(detailForTier(0, 'medium')).toBe(0);
  });

  it('scales motion monotonically', () => {
    const high = motionScaleForTier('high');
    const medium = motionScaleForTier('medium');
    const low = motionScaleForTier('low');
    expect(high).toBe(1);
    expect(medium).toBeLessThan(high);
    expect(low).toBeLessThan(medium);
    expect(low).toBeGreaterThan(0);
  });

  it('never reduces motion to nothing, because motion is part of the theme identity', () => {
    // WHY: a theme whose motion is removed is a different theme. Scaling keeps it recognisable.
    for (const tier of QUALITY_LADDER) {
      expect(motionScaleForTier(tier), tier).toBeGreaterThan(0);
    }
  });
});

describe('frame budget: the thresholds are sane', () => {
  it('derives the frame interval from the fps floor', () => {
    expect(FRAME_BUDGET.maxFrameMs).toBeCloseTo(1000 / FRAME_BUDGET.minFps, 5);
  });

  it('requires a streak long enough to ignore a hiccup', () => {
    // WHY at least 30: at 60fps that is half a second of sustained trouble, which is well past a GC.
    expect(FRAME_BUDGET.consecutiveSlowFrames).toBeGreaterThanOrEqual(30);
  });

  it('has a cooldown so quality cannot oscillate', () => {
    expect(FRAME_BUDGET.cooldownMs).toBeGreaterThan(0);
  });
});

describe('bundle budgets: they exist and they are positive', () => {
  it('budgets the hero chunk and the lazy scene chunk separately', () => {
    // WHY separate: the scene chunk loads only after Web detection, so a single total would let a scene
    // regression hide behind a hero improvement.
    expect(BUNDLE_BUDGET.main).toBeGreaterThan(0);
    expect(BUNDLE_BUDGET.scene).toBeGreaterThan(0);
    expect(BUNDLE_BUDGET.css).toBeGreaterThan(0);
  });
});

describe('budget reporting: a failure says how far over it is', () => {
  it('passes when a value is within budget', () => {
    const r = budgetReport('main', 80 * 1024, BUNDLE_BUDGET.main);
    expect(r.ok).toBe(true);
    expect(r.usedPercent).toBeLessThan(100);
  });

  it('reports the overage so the fix is actionable', () => {
    // WHY the percentage: "over budget" forces a second run to find out by how much. A developer needs
    // to know whether to shave 2 kB or rethink a dependency.
    const r = budgetReport('main', 100 * 1024, BUNDLE_BUDGET.main);
    expect(r.ok).toBe(false);
    expect(r.usedPercent).toBeGreaterThan(100);
  });

  it('treats exactly-on-budget as a pass', () => {
    expect(budgetReport('x', 100, 100).ok).toBe(true);
  });

  it('summarizes every breach rather than stopping at the first', () => {
    // WHY: stopping at the first forces the developer to fix and re-run once per breach.
    const summary = summarizeBudgets([
      budgetReport('main', 100, 90),
      budgetReport('scene', 200, 130),
      budgetReport('css', 5, 12),
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.message).toContain('main');
    expect(summary.message).toContain('scene');
    expect(summary.message).not.toContain('css');
  });

  it('reports success with a count, so a green run is legible', () => {
    expect(summarizeBudgets([budgetReport('a', 1, 9)]).ok).toBe(true);
  });
});