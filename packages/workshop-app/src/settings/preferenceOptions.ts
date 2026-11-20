import type { Theme } from '@/prefs/appearance'
import type { MotionLevel } from '@gadgets/ui'

/** What the theme can be set to, as the settings and search both name it. */
export const THEME_OPTIONS: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

/** What the animations can be set to, as the settings and search both name it. */
export const MOTION_OPTIONS: { id: MotionLevel; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'calm', label: 'Calm' },
  { id: 'off', label: 'Off' },
]
