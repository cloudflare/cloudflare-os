import { useReducer } from 'react'
import { DesktopIcon, MoonIcon, PaletteIcon, SidebarSimpleIcon, SparkleIcon, SunIcon } from '@phosphor-icons/react'
import { useMotionLevel } from '@/hooks/useMotionLevel'
import { readTheme, writeTheme, type Theme } from '@/prefs/appearance'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { writeMotionLevel, type MotionLevel } from '@/prefs/motion'
import { MOTION_OPTIONS, THEME_OPTIONS } from './preferenceOptions'
import type { ChoiceSetting, ToggleSetting } from './settingDefinition'

/** The Preferences settings that are kept on this device, each in force as it is set. */
export const usePreferenceSettings = () => {
  // The layout is read as it stands, so it is read again once changed here.
  const [, changed] = useReducer((count: number) => count + 1, 0)
  const motion = useMotionLevel()
  const theme = readTheme()
  const opensNewOutputs = readLayoutPrefs().opensNewOutputs !== false

  const themeSetting: ChoiceSetting<Theme> = {
    kind: 'choice',
    section: 'preferences',
    title: 'Theme',
    description: 'Follows your system unless you choose. Saved in this browser.',
    keywords: ['appearance', 'color', 'colour', 'mode'],
    icon: PaletteIcon,
    value: theme,
    options: THEME_OPTIONS,
    optionIcons: { system: DesktopIcon, light: SunIcon, dark: MoonIcon },
    placeholder: 'System',
    set: (next) => {
      writeTheme(next)
      changed()
    },
  }
  const motionSetting: ChoiceSetting<MotionLevel> = {
    kind: 'choice',
    section: 'preferences',
    title: 'Animations',
    description: 'Follows your system unless you choose. Saved in this browser.',
    keywords: ['motion', 'reduce', 'reduced', 'transitions'],
    icon: SparkleIcon,
    value: motion,
    options: MOTION_OPTIONS,
    placeholder: 'Full',
    set: writeMotionLevel,
  }
  const autoOpenOutputs: ToggleSetting = {
    kind: 'toggle',
    section: 'preferences',
    title: 'Auto-open outputs',
    description: 'Open apps, documents and other outputs in the side pane as soon as the assistant creates them. Saved in this browser.',
    keywords: ['side pane', 'apps', 'documents', 'open'],
    icon: SidebarSimpleIcon,
    checked: opensNewOutputs,
    set: (next) => {
      writeLayoutPrefs({ opensNewOutputs: next })
      changed()
    },
  }
  return { theme: themeSetting, motion: motionSetting, autoOpenOutputs }
}
