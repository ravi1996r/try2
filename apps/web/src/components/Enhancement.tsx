import { useEffect, useRef, useState } from 'react';
import { useTheme, THEMES, type ThemeId } from '../hooks/useTheme';
import { useContactReveal } from '../hooks/useContactReveal';
import { useActiveSection } from '../hooks/useActiveSection';
import type { SceneHandle } from '../scene/Scene';
import { ChatPanel } from './ChatPanel';
import { ModelSwitcher, type SwitcherHandle } from './ModelSwitcher';

/**
 * The enhancement layer: a 3D scene, theme and contact controls, and the chat panel.
 *
 * WHY this component owns almost nothing: the scene has its own render loop (AGENTS.md: one
 * render-loop owner), and every piece of state lives in a hook. This file is composition only.
 */
type SceneState = 'probing' | 'running' | 'reduced-motion' | 'unavailable';

function probeWebGL(canvas: HTMLCanvasElement): boolean {
  try {
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch (err) {
    // WHY caught: some browsers throw rather than return null when WebGL is disabled by policy.
    console.warn('[enhancement] WebGL probe threw:', err);
    return false;
  }
}

export function Enhancement() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  const [state, setState] = useState<SceneState>('probing');
  const { theme, setTheme } = useTheme();
  const { revealContact, state: reveal } = useContactReveal();
  const active = useActiveSection();
  // WHY one ref shared by both panels: the switcher writes the visitor's provider/key/model here and
  // the chat panel reads it at send time. Keeping it as a ref (not state) is what guarantees the key
  // never enters the render tree, a devtools snapshot, or an error boundary dump.
  const byokRef = useRef<SwitcherHandle | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setState('unavailable');
      return;
    }
    if (!probeWebGL(canvas)) {
      setState('unavailable');
      return;
    }

    let disposed = false;
    // WHY the dynamic import here and not at module top: three.js is ~690 kB. Importing it before
    // this probe would spend that on a device that cannot render anything.
    void (async () => {
      try {
        const { createScene, readAccentColor } = await import('../scene/Scene');
        if (disposed) return;
        const handle = await createScene(canvas, readAccentColor());
        // WHY re-check AFTER the await: this component can unmount while three.js is still parsing,
        // and building a scene against a detached canvas leaks its GPU buffers.
        if (disposed) {
          handle.dispose();
          return;
        }
        sceneRef.current = handle;
        setState(handle.kind);
      } catch (err) {
        console.warn('[enhancement] scene failed to start:', err);
        if (!disposed) setState('unavailable');
      }
    })();

    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  // WHY re-tint rather than rebuild: rebuilding on every theme change would tear down and recreate
  // WebGL buffers for a colour change, which shows as a visible stutter.
  useEffect(() => {
    if (!sceneRef.current) return;
    void import('../scene/Scene').then(({ readAccentColor }) => {
      sceneRef.current?.setAccent(readAccentColor());
    });
  }, [theme]);

  return (
    <div className="enhancement" data-testid="enhancement">
      <canvas
        ref={canvasRef}
        className="scene"
        aria-hidden="true"
        // WHY a data attribute rather than inline styles: the theme is applied as a CSS custom
        // property on :root, and style-src permits 'unsafe-inline' for exactly this reason. Driving
        // it from a data attribute keeps the DOM the single source of the current theme.
        data-theme={theme}
      />
      <div className="enhancement-controls">
        <label className="theme-label" htmlFor="theme-select">Theme</label>
        <select
          id="theme-select"
          className="theme-select"
          value={theme}
          // WHY the narrowing rather than a cast: a <select> always reports a string, so the union
          // has to be re-established. Rejecting an unknown id here means a stale localStorage value
          // or a future rename degrades to "ignore the change" instead of applying an undefined theme.
          onChange={(e) => {
            const next = e.target.value;
            if (THEMES.some((t) => t.id === next)) setTheme(next as ThemeId);
          }}
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="reveal-button"
          onClick={() => { void revealContact(); }}
          disabled={reveal.status === 'loading' || reveal.status === 'shown'}
        >
          {reveal.status === 'loading' && 'Loading contact details\u2026'}
          {reveal.status === 'shown' && 'Contact details shown'}
          {(reveal.status === 'idle' || reveal.status === 'failed') && 'Show contact details'}
        </button>
      </div>
      {reveal.status === 'shown' && (
        <dl className="reveal-list" data-testid="reveal-list">
          {Object.entries(reveal.values).map(([key, value]) => (
            <div key={key} className="reveal-row">
              {/* WHY <dt> for the field name: a definition list is the correct semantic pairing, and
                  it is what a screen reader announces when navigating the revealed values. */}
              <dt>{key}</dt>
              <dd>{/^https?:\/\//.test(value)
                ? <a href={value} rel="noopener noreferrer nofollow" target="_blank">{value}</a>
                : value}</dd>
            </div>
          ))}
        </dl>
      )}
      {reveal.status === 'failed' && (
        <p className="reveal-error" role="alert">{reveal.message}</p>
      )}
      <p className="enhancement-status" role="status" aria-live="polite">
        {state === 'probing' && 'Checking 3D support\u2026'}
        {state === 'running' && '3D scene running. This page is complete without it.'}
        {state === 'reduced-motion'
          && 'Reduced motion is on, so the 3D scene renders as a still image. The page is complete without it.'}
        {state === 'unavailable'
          && 'WebGL is unavailable here, so 3D cannot render. The text version is the complete page.'}
      </p>
      <ModelSwitcher handle={byokRef} />
      <ChatPanel activeSection={active} byok={byokRef} />
    </div>
  );
}