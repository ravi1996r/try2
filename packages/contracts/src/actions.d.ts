/**
 * Type declarations for the shared action validator.
 *
 * WHY this file exists: apps/web runs `tsc` under `strict`, and the validator is plain JS so the
 * gateway and the browser share one implementation. Without a declaration file TypeScript infers
 * `any`, which would silently defeat the type checking on the very boundary that must not be `any`.
 *
 * WHY hand-written rather than generated: the return type is a discriminated union whose `ok` flag
 * forces every caller to handle the rejection path. Generated types could not express that guarantee.
 */
import type { ACTION_NAMES as ActionNames, FONT_ALLOWLIST as Fonts, MOTION_MODES as Motion, QUALITY_TIERS as Tiers, THEME_NAMES as Themes } from './index.js';

export type ActionName = (typeof ActionNames)[number];
export type ThemeId = (typeof Themes)[number];
export type FontId = (typeof Fonts)[number];
export type MotionMode = (typeof Motion)[number];
export type QualityTier = (typeof Tiers)[number];

/** A validated action. `args` is always present, even for actions that take none. */
export interface MasterAction {
  name: ActionName;
  args: Record<string, unknown>;
}

/**
 * The result is a discriminated union on `ok`, so a caller cannot read `.action` without first
 * checking the rejection path. That is the property that keeps a refused action from being applied.
 */
export type ValidationResult =
  | { ok: true; action: MasterAction }
  | { ok: false; reason: string };

export interface BatchValidationResult {
  applied: MasterAction[];
  rejected: Array<{ reason: string }>;
}

export declare const SCROLL_SECTIONS: readonly string[];
export declare const FONT_SCALE_FLOOR: number;
export declare const FONT_SCALE_CEILING: number;
export declare const NO_ARG_ACTIONS: readonly string[];

export declare function validateAction(raw: unknown): ValidationResult;
export declare function validateActions(raw: unknown): BatchValidationResult;