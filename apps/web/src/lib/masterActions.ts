/**
 * Browser-authoritative dispatch of Master bot actions, with undo, redo and reset.
 *
 * WHY "authoritative" and not merely "applied": the server proposes, this store decides. A `tool_call`
 * may arrive from this project's AI service OR from a provider the visitor's own key reaches directly,
 * so the page cannot assume the sender honoured the same rules. Every action is revalidated here
 * against the shared vocabulary before it touches the DOM, and anything that fails is recorded as
 * rejected rather than partially applied.
 *
 * WHY undo/redo/reset exist at all: the bot changes a visitor's accessibility settings. If it enlarges
 * the text, the way back must be as easy as the change. An accessibility control without an escape
 * hatch is a trap, so `undo`, `redo` and `reset_ui` are first-class actions and `reset_ui` returns to a
 * snapshot captured before the bot touched anything.
 *
 * WHY a plain class and not React state: the render loop owns the DOM, and routing UI changes through
 * React state would re-render the tree on every streamed tool_call. This applies effects directly and
 * notifies React only of the derived state the UI displays.
 *
 * ALTERNATIVES: (a) apply server-side, (b) trust the model, (c) no undo.
 * WHY NOT: (a) the server has no DOM; (b) is the vulnerability; (c) traps a visitor in settings the bot
 * changed without their consent.
 */
import { validateAction } from '@portfolio/contracts/actions';
import type { MasterAction, UiSnapshot } from './masterActions.types';

export type { MasterAction, UiSnapshot };

/** How many steps the visitor can walk back. Bounded so a long session cannot grow the heap. */
export const HISTORY_LIMIT = 50;

export interface DispatchResult {
  ok: boolean;
  reason?: string;
}

export type ActionSink = (state: UiSnapshot) => void;

/** The complete set of state the bot may touch, so the vocabulary and reachable UI state match. */
export const INITIAL_SNAPSHOT: UiSnapshot = Object.freeze({
  theme: 'modern',
  font: 'Inter',
  fontScale: 1,
  accent: '#3b82f6',
  motion: 'on',
  quality: 'auto',
  cameraPreset: null,
  highContrast: false,
  dyslexiaFont: false,
  layout: 'grid',
  sound: false,
  volume: 0.5,
  openBot: null,
} as UiSnapshot);

const clone = (s: UiSnapshot): UiSnapshot => ({ ...s });

export class MasterActionStore {
  private state: UiSnapshot;

  private past: UiSnapshot[] = [];

  private future: UiSnapshot[] = [];

  /** Captured before the bot changes anything, so `reset_ui` can undo the whole session. */
  private pristine: UiSnapshot;

  private sink: ActionSink;

  constructor(sink: ActionSink, initial: UiSnapshot = INITIAL_SNAPSHOT) {
    this.sink = sink;
    this.state = clone(initial);
    this.pristine = clone(initial);
  }

  /** A copy, so a caller cannot mutate the store by holding the reference. */
  get snapshot(): UiSnapshot {
    return clone(this.state);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** True once the bot has changed anything; this is what enables the reset affordance. */
  get isDirty(): boolean {
    return this.past.length > 0;
  }

  /** Validates and applies one action, returning whether it was applied and why not if refused. */
  dispatch(raw: unknown): DispatchResult {
    // WHY validate HERE and not on arrival: this is the last gate before the DOM, and the only gate
    // that definitely runs on the browser-direct path where the gateway was never involved.
    const result = validateAction(raw);
    if (!result.ok) return { ok: false, reason: result.reason };

    // WHY meta actions skip the history push: `undo` must not itself become an undoable step, or the
    // history would grow every time the visitor pressed it.
    if (result.action.name === 'undo') return this.undo();
    if (result.action.name === 'redo') return this.redo();
    if (result.action.name === 'reset_ui') return this.reset();

    const next = this.reduce(this.state, result.action);
    if (next === null) return { ok: false, reason: `action "${result.action.name}" had no effect` };
this.pushHistory();
    this.state = next;
    this.sink(clone(this.state));
    return { ok: true };
  }

  /**
   * The single place an action becomes a state change.
   *
   * WHY a reducer rather than a switch inside dispatch: history, the sink and undo all need to agree
   * on exactly one transition. Two code paths computing "the next state" is how undo ends up subtly
   * different from redo.
   *
   * @returns the next snapshot, or null when the action has no local effect.
   */
  private reduce(state: UiSnapshot, action: MasterAction): UiSnapshot | null {
    const a = action.args as Record<string, unknown>;
    switch (action.name) {
      case 'set_theme':
        return { ...state, theme: a.theme as string };
      case 'set_font':
        return { ...state, font: a.font as string };
      case 'set_font_size':
        // WHY re-clamped here: validateAction already clamped, but this store is what actually writes
        // the value, so the bound is asserted at the point of use rather than only upstream.
        return { ...state, fontScale: Math.min(1.6, Math.max(0.85, a.scale as number)) };
      case 'set_accent':
        return { ...state, accent: a.color as string };
      case 'toggle_motion':
        return { ...state, motion: a.mode as UiSnapshot['motion'] };
      case 'set_quality':
        return { ...state, quality: a.tier as UiSnapshot['quality'] };
      case 'set_camera_preset':
        return { ...state, cameraPreset: a.preset as string };
      case 'set_layout':
        return { ...state, layout: a.layout as UiSnapshot['layout'] };
      case 'toggle_sound':
        return { ...state, sound: a.on as boolean };
      case 'set_volume':
        return { ...state, volume: Math.min(1, Math.max(0, a.volume as number)) };
      case 'toggle_high_contrast':
        return { ...state, highContrast: a.on as boolean };
      case 'toggle_dyslexia_friendly_font':
        return { ...state, dyslexiaFont: a.on as boolean };
      case 'open_chatbot':
        return { ...state, openBot: a.bot as UiSnapshot['openBot'] };
      case 'close_chatbot':
        // WHY closing the bot that is already closed is a no-op rather than a history entry: the
        // visitor asked for nothing, and an undo that appears to do nothing is worse than none.
        if (a.bot === undefined) return state.openBot === null ? null : { ...state, openBot: null };
        return state.openBot === a.bot ? null : { ...state, openBot: null };
      default:
        // `open_model_settings` has no representation in the page state; the component that renders
        // the dialog subscribes to the action stream separately rather than through this reducer.
        return null;
    }
  }

  private pushHistory() {
    this.past.push(clone(this.state));
    // WHY bounded: a long bot session would otherwise retain every snapshot it passed through. The
    // oldest step is the one a visitor is least likely to want back.
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    // WHY a new action clears redo: the future referred to a timeline that no longer exists. Keeping
    // it would let `redo` jump to a state that skips the action just performed.
    this.future.length = 0;
  }

  undo(): DispatchResult {
    const previous = this.past.pop();
    if (!previous) return { ok: false, reason: 'nothing to undo' };
    this.future.push(clone(this.state));
    this.state = previous;
    this.sink(clone(this.state));
    return { ok: true };
  }

  redo(): DispatchResult {
    const next = this.future.pop();
    if (!next) return { ok: false, reason: 'nothing to redo' };
    this.past.push(clone(this.state));
    this.state = next;
    this.sink(clone(this.state));
    return { ok: true };
  }

  /**
   * Returns to the state captured before the bot touched anything.
   *
   * WHY this clears the history: after a reset the visitor has a clean page, and offering to "undo" the
   * reset would restore the settings the visitor just asked to discard.
   */
  reset(): DispatchResult {
    if (!this.isDirty) return { ok: false, reason: 'nothing to reset' };
    this.past.length = 0;
    this.future.length = 0;
    this.state = clone(this.pristine);
    this.sink(clone(this.state));
    return { ok: true };
  }
}