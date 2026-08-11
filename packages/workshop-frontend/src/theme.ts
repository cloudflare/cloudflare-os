// Runtime color theming.
//
// The base light/dark palettes are defined statically in styles.css via Tailwind `@theme` CSS
// variables and `[data-mode="dark"]` overrides. Theme mode is applied on <html> so Kumo's semantic
// tokens and native controls resolve consistently. We also let a deployment override the *accent*
// family at runtime by setting those CSS variables on :root from an admin-chosen seed color.
// Hover/lighter/selection shades are derived from the seed with CSS relative-color syntax
// (`oklch(from <seed> ...)`), so the admin only picks one color.
//
// Only the accent-related variables are overridden at runtime; backgrounds, lines, and neutral text
// follow the light/dark palettes selected by `data-mode` in styles.css. The shared applicator
// validates the seed before interpolating it into CSS values.

import { applyAccentColor as applyAccentColorToStyle } from '@gadgets/workshop-shared/theme'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedThemeMode = 'light' | 'dark'

const THEME_MODE_STORAGE_KEY = 'gadgets:theme-mode'

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function getSystemThemeMode(): ResolvedThemeMode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function readThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY)
    return isThemeMode(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function writeThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode)
  } catch {
    // Ignore storage failures; the selected mode still applies for this session.
  }
}

export function resolveThemeMode(mode: ThemeMode): ResolvedThemeMode {
  return mode === 'system' ? getSystemThemeMode() : mode
}

export function applyThemeMode(mode: ThemeMode): ResolvedThemeMode {
  const resolved = resolveThemeMode(mode)
  const root = document.documentElement

  root.setAttribute('data-mode', resolved)
  root.style.colorScheme = resolved

  return resolved
}

export function applyStoredThemeMode(): ResolvedThemeMode {
  return applyThemeMode(readThemeMode())
}

// Apply the accent color to the document root. Pass "" / invalid to clear back to the base theme.
export function applyAccentColor(color: string | null | undefined): void {
  applyAccentColorToStyle(document.documentElement.style, color)
}

// The base/default accent, shown in the admin picker when no custom color is set.
export const DEFAULT_ACCENT_COLOR = '#ff4801'
