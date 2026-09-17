/**
 * Stable per-panel accents for the prismatic theme: every bordered panel
 * claims the next slot in a first-seen sequence keyed by its stable id, so a
 * screen with several open panels shows several ring colors while each panel
 * keeps one learnable color. Deliberately NOT a React hook — several panels
 * render through direct function calls inside conditionals, where hooks are
 * illegal — and identity is by panel id, not by mount. Outside prismatic the
 * helper is an identity: callers pass their usual border/title colors
 * through unchanged and dark/light render pixel-identically.
 *
 * @module @deepseek-ai/dsh-tui/panel-accent
 */

import { surfaceAccent, type RgbTriple } from './theme.ts'

/** First-seen slot per panel id; stable for the process lifetime. */
const panelSlots = new Map<string, number>()

/** One panel's resolved accent pair (border and title share the ring color in prismatic). */
export interface PanelAccent {
  readonly border: RgbTriple
  readonly title: RgbTriple
}

/**
 * The accent pair for one panel: in prismatic both entries are the panel's
 * ring color (border and title match, per the design); in every other theme
 * they are exactly the colors passed in.
 * @param id - stable panel identity ('todos', 'model', 'kernel-list', …).
 * @param border - the border color used outside prismatic.
 * @param title - the title color used outside prismatic (defaults to border).
 * @returns the resolved accent pair for this panel.
 */
export function panelAccent(id: string, border: RgbTriple, title: RgbTriple = border): PanelAccent {
  let slot = panelSlots.get(id)
  if (slot === undefined) {
    slot = panelSlots.size
    panelSlots.set(id, slot)
  }
  return { border: surfaceAccent(slot, border), title: surfaceAccent(slot, title) }
}
