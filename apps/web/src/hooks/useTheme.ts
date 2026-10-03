import { useCallback, useEffect, useState } from 'react';

/**
 * Theme selection.
 *
 * WHY these ids match the gateway's `/v1/config` `themes` array exactly: the gateway is the server
 * that advertises the product's theme list, and the browser mirrors it. An earlier draft invented a
 * different set (`default`/`midnight`/`paper`/...), which created two competing lists that would
 * drift the first time a theme was added. One source of truth: the gateway.
 *
 * WHY this hook does not fetch that list at runtime: it is a compile-time union, so a theme id that
 * the gateway does not know is a type error rather than a silently unstyled page. The runtime list
 * still arrives from /v1/config for anything that needs to display it.
 */
export const THEMES = [
  { id: 'chill', label: 'Chill' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'fantasy', label: 'Fantasy' },
  { id: 'retro', label: 'Retro' },
  { id: 'modern', label: 'Modern' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const STORAGE_KEY = 'portfolio:theme';
const DEFAULT_THEME: ThemeId = 'chill';

function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

function readStored(): ThemeId {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // WHY validate rather than trust: localStorage is user-writable and survives deploys. A stale or
    // hand-edited value must not be able to apply an undefined theme.
    return isThemeId(raw) ? raw : DEFAULT_THEME;
  } catch {
    // WHY caught: Safari in private mode throws on localStorage access, and a theme preference is
    // not worth breaking the page over.
    return DEFAULT_THEME;
  }
}

/**
 * Current theme, persisted, applied to <html data-theme>.
 *
 * WHY the attribute goes on documentElement and not the React root: the prerendered page's styles
 * are already loaded and must re-theme too. Scoping the attribute to #root would restyle only the
 * enhancement and leave the content above it in the old palette.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(DEFAULT_THEME);

  // WHY read in an effect rather than during render: this touches localStorage and document, both of
  // which do not exist during SSR and would make the first render differ from the hydrated one.
  useEffect(() => {
    setThemeState(readStored());
  }, []);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A failed write only costs persistence across reloads, not correctness for this session.
    }
  }, []);

  // Keep the DOM in sync when the theme changes by any route (including a restored stored value).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return { theme, setTheme };
}