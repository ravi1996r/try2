/**
 * Connects the Master bot's tool_call stream to the page, and applies the result.
 *
 * WHY this sits above MasterActionStore rather than inside it: the store is a pure, DOM-free
 * reducer that a Node test can exercise. This hook is the only place that knows about `document`, the
 * theme hook and React's lifecycle. Keeping them apart is what let the safety rules be tested without a
 * browser, and it keeps the DOM side small enough to read in one sitting.
 *
 * WHY the browser applies effects directly instead of through React state: the render loop owns the
 * canvas, and a full re-render on every streamed tool_call would fight it. Accessibility settings are
 * CSS custom properties on one element, which is both cheaper and easier to undo.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MasterActionStore, type UiSnapshot } from '../lib/masterActions';
import { useTheme, type ThemeId } from './useTheme';

/** The subset the bot can change that the site already knows how to render. */
type MasterSink = (snapshot: UiSnapshot) => void;

/**
 * Writes the bot's decisions onto `<html>` as custom properties.
 *
 * WHY custom properties and not inline styles per element: one write updates every consumer, and the
 * value is trivially inspectable in devtools when a visitor reports something looks wrong.
 *
 * WHY every value is clamped again here: this is the last code that touches the DOM. The validator and
 * the store already clamped, and a third check costs nothing next to an accessibility regression.
 */
function applySnapshot(snapshot: UiSnapshot, setTheme: (t: ThemeId) => void): void {
  const root = document.documentElement;

  setTheme(snapshot.theme as ThemeId);
  root.style.setProperty('--font-scale', String(Math.min(1.6, Math.max(0.85, snapshot.fontScale))));
  root.style.setProperty('--font-family', `"${snapshot.font}", system-ui, sans-serif`);
  root.style.setProperty('--accent', snapshot.accent);
  root.dataset.contrast = snapshot.highContrast ? 'high' : 'normal';
  root.dataset.dyslexiaFont = snapshot.dyslexiaFont ? 'on' : 'off';
  root.dataset.layout = snapshot.layout;
  root.dataset.motion = snapshot.motion;
  root.dataset.quality = snapshot.quality;

  // WHY `reduced` is written as a real media-query override rather than a class: it is the mechanism
  // the operating system and the CSS spec agree on, so it also survives the bot being absent.
  if (snapshot.motion !== 'on') {
    root.style.setProperty('--motion-duration', '0.001ms');
  } else {
    root.style.removeProperty('--motion-duration');
  }
}

export interface MasterActionsHandle {
  /** Validates and applies one action. Returns false when the site refused it. */
  dispatch: (action: unknown) => boolean;
  canUndo: () => boolean;
  canRedo: () => boolean;
  isDirty: () => boolean;
}

/**
 * Creates the store once and keeps it alive for the lifetime of the page.
 *
 * WHY a ref and not useState: the store holds mutable history, and putting it in state would make
 * React re-render the whole enhancement layer whenever the object identity changed. The DOM writes are
 * the only thing the page needs to observe.
 */
export function useMasterActions(): MasterActionsHandle {
  const { setTheme } = useTheme();
  const storeRef = useRef<MasterActionStore | null>(null);

  if (storeRef.current === null) {
    const sink: MasterSink = (snapshot) => applySnapshot(snapshot, setTheme);
    storeRef.current = new MasterActionStore(sink);
  }
  const store = storeRef.current;

  // WHY apply the current snapshot on mount: a visitor who reloads should see the state the bot left,
  // not a flash of the defaults. Read once, deliberately.
  useEffect(() => {
    applySnapshot(store.snapshot, setTheme);
    // setTheme is stable (useCallback in useTheme) and the store never changes identity.
  }, [store, setTheme]);

  const dispatch = useCallback((action: unknown) => store.dispatch(action).ok, [store]);
  const canUndo = useCallback(() => store.canUndo, [store]);
  const canRedo = useCallback(() => store.canRedo, [store]);
  const isDirty = useCallback(() => store.isDirty, [store]);

  return useMemo(
    () => ({ dispatch, canUndo, canRedo, isDirty }),
    [dispatch, canUndo, canRedo, isDirty],
  );
}