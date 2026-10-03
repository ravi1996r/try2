/**
 * The store is the last gate before the DOM, so these tests are about two guarantees:
 *   1. A hostile or broken model cannot push the page into an unusable state.
 *   2. Whatever it does change, the visitor can walk back -- including after a whole session.
 *
 * WHY the store is tested directly rather than through the browser: the reducer is pure, and asserting
 * on pure state is more precise than inferring intent from rendered CSS. E2E covers that the DOM
 * actually follows.
 */
import { describe, it, expect, vi } from 'vitest';
import { MasterActionStore, INITIAL_SNAPSHOT, HISTORY_LIMIT } from '../src/lib/masterActions';

const make = (initial) => {
  const sink = vi.fn();
  const store = new MasterActionStore(sink, { ...INITIAL_SNAPSHOT, ...initial });
  return { store, sink };
};

describe('master store: the bot applies what the visitor asked for', () => {
  it('applies a valid action and notifies the sink once', () => {
    const { store, sink } = make();
    expect(store.dispatch({ name: 'set_theme', args: { theme: 'cyberpunk' } })).toEqual({ ok: true });
    expect(store.snapshot.theme).toBe('cyberpunk');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('notifies the sink with a copy, so a consumer cannot mutate the store', () => {
    const { store, sink } = make();
    store.dispatch({ name: 'set_theme', args: { theme: 'retro' } });
    const handed = sink.mock.calls[0][0];
    handed.theme = 'tampered';
    expect(store.snapshot.theme).toBe('retro');
  });
});

describe('master store: a hostile model cannot take the page over', () => {
  it('refuses an action outside the vocabulary and changes nothing', () => {
    const { store, sink } = make();
    const before = store.snapshot;
    expect(store.dispatch({ name: 'eval_in_devtools', args: {} }).ok).toBe(false);
    expect(store.snapshot).toEqual(before);
    expect(sink).not.toHaveBeenCalled();
  });

  it('cannot shrink the text below the legibility floor, however it asks', () => {
    // WHY this specific attack: a bot that could set fontScale to 0.1 would leave the visitor unable to
    // read the page, and could then refuse to enlarge it again.
    const { store } = make();
    store.dispatch({ name: 'set_font_size', args: { scale: 0.0001 } });
    expect(store.snapshot.fontScale).toBeGreaterThanOrEqual(0.85);
  });

  it('cannot smuggle extra properties that the reducer would ignore', () => {
    const { store } = make();
    expect(store.dispatch({ name: 'set_theme', args: { theme: 'chill', x: 1 } }).ok).toBe(false);
    expect(store.snapshot.theme).toBe(INITIAL_SNAPSHOT.theme);
  });

  it('never throws on malformed input', () => {
    const { store } = make();
    for (const hostile of [null, undefined, 42, 'set_theme', [], { name: 'set_font_size' }]) {
      expect(() => store.dispatch(hostile)).not.toThrow();
      expect(store.dispatch(hostile).ok).toBe(false);
    }
  });
});

describe('master store: undo and redo are exact inverses', () => {
  it('walks back and forward through several actions', () => {
    const { store } = make();
    store.dispatch({ name: 'set_theme', args: { theme: 'fantasy' } });
    store.dispatch({ name: 'set_font_size', args: { scale: 1.4 } });
    expect(store.snapshot).toMatchObject({ theme: 'fantasy', fontScale: 1.4 });

    store.dispatch({ name: 'undo' });
    expect(store.snapshot).toMatchObject({ theme: 'fantasy', fontScale: 1 });

    store.dispatch({ name: 'redo' });
    expect(store.snapshot).toMatchObject({ theme: 'fantasy', fontScale: 1.4 });
  });

  it('refuses to undo or redo past the ends instead of inventing a state', () => {
    const { store } = make();
    expect(store.dispatch({ name: 'undo' }).ok).toBe(false);
    expect(store.dispatch({ name: 'redo' }).ok).toBe(false);
    expect(store.snapshot).toEqual(INITIAL_SNAPSHOT);
  });

  it('discards the redo branch once a new action diverges', () => {
    // WHY: keeping a stale redo would let the visitor land in a state that skips the action they just
    // performed, which reads as the bot misbehaving.
    const { store } = make();
    store.dispatch({ name: 'set_theme', args: { theme: 'retro' } });
    store.dispatch({ name: 'undo' });
    store.dispatch({ name: 'set_theme', args: { theme: 'chill' } });
    expect(store.canRedo).toBe(false);
    expect(store.dispatch({ name: 'redo' }).ok).toBe(false);
    expect(store.snapshot.theme).toBe('chill');
  });

  it('does not record meta actions as undoable steps', () => {
    const { store } = make();
    store.dispatch({ name: 'set_theme', args: { theme: 'retro' } });
    store.dispatch({ name: 'undo' });
    store.dispatch({ name: 'undo' });
    // Two actions, one recorded step, and the second undo found nothing rather than walking past the
    // start of the session.
    expect(store.snapshot).toEqual(INITIAL_SNAPSHOT);
  });

  it('bounds the history so a long session cannot grow without limit', () => {
    const { store } = make();
    for (let i = 0; i < HISTORY_LIMIT + 25; i += 1) {
      store.dispatch({ name: 'set_accent', args: { color: '#010203' } });
describe('master store: reset escapes the whole session', () => {
  it('returns every setting to where it started', () => {
    const { store } = make();
    store.dispatch({ name: 'set_theme', args: { theme: 'cyberpunk' } });
    store.dispatch({ name: 'set_font_size', args: { scale: 1.6 } });
    store.dispatch({ name: 'toggle_high_contrast', args: { on: true } });
    store.dispatch({ name: 'set_volume', args: { volume: 1 } });

    expect(store.dispatch({ name: 'reset_ui' }).ok).toBe(true);
    expect(store.snapshot).toEqual(INITIAL_SNAPSHOT);
  });

  it('preserves the visitor\'s own settings, not a hardcoded default', () => {
    // WHY: the snapshot taken at construction is the page as the visitor found it. Resetting to a
    // constant would discard a theme they chose by hand, which is a real regression.
    const { store } = make({ theme: 'fantasy', fontScale: 1.2 });
    store.dispatch({ name: 'set_theme', args: { theme: 'retro' } });
    store.dispatch({ name: 'reset_ui' });
    expect(store.snapshot.theme).toBe('fantasy');
    expect(store.snapshot.fontScale).toBe(1.2);
  });

  it('refuses to reset a page it has not touched', () => {
    const { store, sink } = make();
    expect(store.dispatch({ name: 'reset_ui' }).ok).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('master store: a no-op action does not pollute the history', () => {
  it('ignores closing a bot that is not open', () => {
    const { store } = make();
    expect(store.dispatch({ name: 'close_chatbot', args: { bot: 'bot1' } }).ok).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it('still records closing the bot that IS open', () => {
    const { store } = make();
    store.dispatch({ name: 'open_chatbot', args: { bot: 'bot3' } });
    expect(store.dispatch({ name: 'close_chatbot', args: { bot: 'bot3' } }).ok).toBe(true);
    expect(store.snapshot.openBot).toBeNull();
    expect(store.dispatch({ name: 'undo' }).ok).toBe(true);
    expect(store.snapshot.openBot).toBe('bot3');
  });
});
    }
    // WHY assert the bound rather than a count: the exact retained number is an implementation detail,
    // but "unbounded" would be a leak.
    let undos = 0;
    while (store.dispatch({ name: 'undo' }).ok) undos += 1;
    expect(undos).toBe(HISTORY_LIMIT);
  });
});