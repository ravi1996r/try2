import { useEffect, useState } from 'react';

/**
 * Tracks which section is currently in view, and marks the matching nav link.
 *
 * WHY an IntersectionObserver and not a scroll handler: a scroll listener that recomputes position
 * on every frame forces layout on each event and is the single most common cause of jank on a page
 * that also runs a WebGL loop. The observer does the work off the main paint cycle.
 *
 * WHY `rootMargin` biases the band upward: the top 35% is the band that decides "what am I reading".
 * A section filling the bottom of the viewport is usually the one just scrolled past.
 */
export function useActiveSection(): string {
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    // WHY query the existing nav rather than a hardcoded list: the generator owns the section ids and
    // the nav markup, so reading them keeps this correct when a section is added or removed.
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('nav.sections a[href^="#"]'));
    if (links.length === 0) return;

    const byId = new Map<string, Element>();
    for (const link of links) {
      const id = link.getAttribute('href')!.slice(1);
      const section = document.getElementById(id);
      // WHY the skip: a nav link whose target is missing is a generator bug, and throwing here would
      // take down the whole enhancement layer over one broken anchor.
      if (section) byId.set(id, section);
    }
    if (byId.size === 0) return;

    // WHY keep a ratio per entry: IntersectionObserver gives booleans, and with several sections
    // visible at once the booleans alone cannot say which one dominates the band.
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let bestId = '';
        let bestRatio = 0;
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }
        if (bestId) setActive(bestId);
      },
      { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    for (const section of byId.values()) observer.observe(section);

    // WHY apply here and not in the observer callback: the initial hash must be honoured before any
    // scroll happens, or a deep link lands with no nav link marked until the visitor moves.
    const initial = window.location.hash.slice(1);
    if (initial && byId.has(initial)) setActive(initial);

    return () => observer.disconnect();
  }, []);

  // WHY mark the nav imperatively rather than re-rendering the nav from React: the nav is
  // prerendered HTML owned by the generator, and re-rendering it would replace SEO-relevant markup
  // that the whole no-JS guarantee rests on.
  useEffect(() => {
    const links = document.querySelectorAll<HTMLAnchorElement>('nav.sections a[href^="#"]');
    for (const link of links) {
      const isActive = link.getAttribute('href') === `#${active}`;
      // WHY aria-current rather than a class alone: this is how a screen reader announces which
      // section you are in, and it is the only way the state is not purely visual.
      if (isActive) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }, [active]);

  return active;
}