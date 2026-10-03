/**
 * Progressive-enhancement root.
 *
 * WHY this is defensive rather than a blank slate: `dist/index.html` is prerendered by
 * `scripts/build_static_site.py` and is the SEO + no-JS artifact. 32 Python tests assert its
 * structure. React is layered ON TOP of that DOM. If the root container is missing (JS running
 * against the wrong document, or a future refactor that drops the mount point) this component
 * refuses to render instead of throwing away real content or blanking the page.
 *
 * WHY createRoot into an existing node rather than replaceChildren(): the server-rendered content
 * stays in the document for crawlers and for the no-JS path. React appends and manages its own
 * subtree only.
 */
import { createRoot } from 'react-dom/client';
import { Enhancement } from './components/Enhancement';

const MOUNT_ID = 'root';

/** @returns {boolean} true when the mount point existed and React took over. */
function mount(): boolean {
  const host = document.getElementById(MOUNT_ID);
  if (!host) {
    // Fail soft and loud in the console, but leave the prerendered page fully intact.
    console.warn(
      `[enhancement] #${MOUNT_ID} not found; skipping React mount. `
      + 'The prerendered page remains the complete experience.',
    );
    return false;
  }
  createRoot(host).render(<Enhancement />);
  return true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}