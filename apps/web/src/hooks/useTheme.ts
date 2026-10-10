import { useEffect, useCallback, useState } from 'react';
import {
  DEFAULT_THEME, THEME_IDS, THEME_REGISTRY, type ThemeDefinition, type ThemeId,
} from '../scene/themes';

/**
 * Theme selection.
 *
 * WHY these ids match the gateway's `/v1/config` `themes` array exactly: the gateway is the server
 * that advertises the product's theme list, and the browser mirrors it. An earlier draft invented a
 * different set (`default`/`midnight`/`paper`/...), which created two competing lists that would
 * drift the first time a theme was added. One source of truth: the gateway.
 *
 * WHY the ids are re-exported from scene/themes.ts rather than declared here: the theme DATA (palette,
 * scene config, motion posture) lives in one module now, and a theme id is meaningless without it. Two
 * lists of ids is the drift bug this comment already warns about, one file over.
 */
export const THEMES = THEME_IDS.map((id) => ({ id, label: THEME_REGISTRY[id].label }));

export type { ThemeId, ThemeDefinition };

const STORAGE_KEY = 'portfolio:theme';

function isThemeId(value: unknown): value is ThemeId {
  return THEME_IDS.some((t) => t === value);
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