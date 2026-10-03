/**
 * The UI state the Master bot is allowed to touch, and the action shape it receives.
 *
 * WHY this lives in its own file: the store must be importable by tests running under Node without
 * pulling in React, Three.js or the DOM. Keeping the types separate means the reducer's contract can be
 * asserted in a plain unit test instead of only through a browser.
 */

/** One validated action. `args` is always present, even for actions that take none. */
export type MasterAction = { name: string; args: Record<string, unknown> };

/**
 * Everything the bot can change. Deliberately a closed shape: a property that is not here cannot be
 * reached by an action, which is how the action vocabulary stays auditable.
 */
export interface UiSnapshot {
  theme: string;
  font: string;
  fontScale: number;
  accent: string;
  motion: 'on' | 'off' | 'reduced';
  quality: 'low' | 'medium' | 'high' | 'auto';
  cameraPreset: string | null;
  highContrast: boolean;
  dyslexiaFont: boolean;
  layout: 'grid' | 'list' | 'focus';
  sound: boolean;
  volume: number;
  openBot: 'bot1' | 'bot2' | 'bot3' | null;
}