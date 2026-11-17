import { isRecord, stored } from './stored'

/** Whether the app is light or dark: as the system is, or as chosen on this device. */
export type Theme = 'system' | 'light' | 'dark'

export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

// `index.html` reads this key before anything is drawn, and hears of this event to take a new
// choice on at once. It cannot import them, so keep the three in step.
const KEY = 'workshop-app:appearance'
const CHANGED = 'workshop-app:appearance'

const parse = (value: unknown): { theme: Theme } | undefined =>
  isRecord(value) && THEMES.includes(value.theme as Theme) ? { theme: value.theme as Theme } : undefined

const store = stored<{ theme: Theme }>(KEY, parse, { theme: 'system' })

export const readTheme = () => store.read().theme

/**
 * Keeps the theme for this device and has the page take it on now. The page is told which, so
 * that it changes even where nothing can be kept.
 */
export const writeTheme = (theme: Theme) => {
  store.write({ theme })
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: theme }))
}
