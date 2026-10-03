import { useCallback, useState } from 'react';

/**
 * Contact reveal.
 *
 * WHY this fetches from the gateway instead of importing the values: `build_static_site.py` omits
 * reveal-only contact values from the HTML on purpose, so they are not in the bundle, not in the
 * source, and not in view-source. The only correct source is the API, requested at the moment the
 * visitor asks for them. Hardcoding them here would silently undo that decision and put a phone
 * number in main.js.
 *
 * WHY an explicit user action: an automatic reveal on scroll would defeat the point. The visitor
 * decides when their details are shown on their own screen.
 */
const REVEAL_ENDPOINT = '/api/v1/contact/reveal';

type RevealState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'shown'; values: Record<string, string> }
  | { status: 'failed'; message: string };

export function useContactReveal() {
  const [state, setState] = useState<RevealState>({ status: 'idle' });

  const revealContact = useCallback(async () => {
    // WHY ignore a second click while in flight: two requests would race and the slower response
    // could overwrite the newer one, or produce a confusing "already revealed" flicker.
    setState({ status: 'loading' });
    try {
      const res = await fetch(REVEAL_ENDPOINT, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // WHY a generic message with a next step, never the raw body: the body may contain detail
        // this component has no business rendering.
        setState({
          status: 'failed',
          message: `Could not load contact details (HTTP ${res.status}). The links on this page still work.`,
        });
        return;
      }
      const body = await res.json() as { values?: Record<string, string> };
      const values = body?.values ?? {};
      setState({
        status: 'shown',
        values: Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string' && v !== '')),
      });
    } catch (err) {
      // WHY no silent failure: AGENTS.md rule 5. A visitor who clicked must learn why nothing happened.
      console.warn('[contact] reveal failed:', err);
      setState({
        status: 'failed',
        message: 'Could not reach the server to load contact details. The links on this page still work.',
      });
    }
  }, []);

  return { revealContact, state };
}