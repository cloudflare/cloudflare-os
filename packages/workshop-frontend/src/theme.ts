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
// follow the light/dark palettes selected by `data-mode` in styles.css. The seed is always a
// validated hex string (see isHexColor), so interpolating it into the CSS strings below is safe.

import { isHexColor } from '@gadgets/workshop-shared/api'

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

// Variables derived from the seed, as (name -> value-template) pairs. `light-dark()` keeps custom
// deployment accents mode-aware without needing to reapply them when the user toggles themes.
export function accentVars(seed: string): Record<string, string> {
  return {
    '--color-kumo-brand': `light-dark(${seed}, oklch(from ${seed} 0.45 c h))`,
    // Slightly darker for hover/pressed states.
    '--color-kumo-brand-hover': `light-dark(oklch(from ${seed} calc(l - 0.06) c h), oklch(from ${seed} 0.38 c h))`,
    '--color-accent-100': `light-dark(${seed}, oklch(from ${seed} 0.45 c h))`,
    // Lighter/brighter secondary accent.
    '--color-accent-200': `light-dark(oklch(from ${seed} calc(l + 0.08) c h), oklch(from ${seed} 0.76 c h))`,
    '--text-color-kumo-brand': `light-dark(${seed}, oklch(from ${seed} 0.76 c h))`,
    '--text-color-kumo-link': `light-dark(${seed}, oklch(from ${seed} 0.76 c h))`,
    // Soft tinted selection background + readable selection text.
    '--color-selection-bg': `light-dark(oklch(from ${seed} 0.94 calc(c * 0.35) h), oklch(from ${seed} 0.28 calc(c * 0.45) h))`,
    '--color-selection-text': `light-dark(oklch(from ${seed} calc(l - 0.06) c h), oklch(0.97 0.006 285))`,
  }
}

const ALL_VARS = Object.keys(accentVars('#000'))

// Apply the accent color to the document root. Pass "" / invalid to clear back to the base theme.
export function applyAccentColor(color: string | null | undefined): void {
  const root = document.documentElement
  if (!color || !isHexColor(color)) {
    for (const v of ALL_VARS) root.style.removeProperty(v)
    return
  }
  for (const [v, value] of Object.entries(accentVars(color))) {
    root.style.setProperty(v, value)
  }
}

// The base/default accent, shown in the admin picker when no custom color is set.
export const DEFAULT_ACCENT_COLOR = '#ff4801'
