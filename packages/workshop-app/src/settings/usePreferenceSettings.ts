import { useReducer } from 'react'
import {
  AiMagicIcon, Brain03Icon, CodeIcon, ComputerIcon, Moon02Icon, PaintBoardIcon, PanelLeftIcon, Sun03Icon,
} from '@/components/icons'
import { useDevMode } from '@/hooks/useDevMode'
import { useLiveWorkOpen } from '@/hooks/useLiveWorkOpen'
import { type MotionLevel, useMotionLevel } from '@gadgets/ui'
import { readTheme, writeTheme, type Theme } from '@/prefs/appearance'
import { writeDevMode } from '@/prefs/devMode'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { writeMotionLevel } from '@/prefs/motion'
import { MOTION_OPTIONS, THEME_OPTIONS } from './preferenceOptions'
import type { ChoiceSetting, ToggleSetting } from './settingDefinition'

/** The Preferences settings that are kept on this device, each in force as it is set. */
export const usePreferenceSettings = () => {
  // The layout is read as it stands, so it is read again once changed here.
  const [, changed] = useReducer((count: number) => count + 1, 0)
  const motion = useMotionLevel()
  const devMode = useDevMode()
  const [liveWorkOpen, writeLiveWorkOpen] = useLiveWorkOpen()
  const theme = readTheme()
  const opensNewOutputs = readLayoutPrefs().opensNewOutputs !== false

  const themeSetting: ChoiceSetting<Theme> = {
    kind: 'choice',
    section: 'preferences',
    title: 'Theme',
    description: 'Follows your system unless you choose. Saved in this browser.',
    keywords: ['appearance', 'color', 'colour', 'mode'],
    icon: PaintBoardIcon,
    value: theme,
    options: THEME_OPTIONS,
    optionIcons: { system: ComputerIcon, light: Sun03Icon, dark: Moon02Icon },
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
    icon: AiMagicIcon,
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
    icon: PanelLeftIcon,
    checked: opensNewOutputs,
    set: (next) => {
      writeLayoutPrefs({ opensNewOutputs: next })
      changed()
    },
  }
  // The same thing a click on the assistant while it works turns on and off, so it is kept in the one place
  // (`prefs/liveWork`), which is heard of by whoever reads it.
  const alwaysShowThinking: ToggleSetting = {
    kind: 'toggle',
    section: 'preferences',
    title: 'Always show thinking',
    description: 'Show what the assistant is doing while it works, and how each reply came about, without having to open it. Clicking the assistant while it works turns this on or off too. Saved in this browser.',
    keywords: ['thinking', 'reasoning', 'steps', 'work', 'tools', 'history', 'trace', 'expand'],
    icon: Brain03Icon,
    checked: liveWorkOpen,
    set: writeLiveWorkOpen,
  }
  const developerMode: ToggleSetting = {
    kind: 'toggle',
    section: 'preferences',
    title: 'Developer mode',
    description: 'Show the model, context size and cost under the composer, what each workspace and chat has cost, and technical details of messages.',
    keywords: ['developer', 'debug', 'cost', 'tokens', 'context', 'model', 'thinking', 'technical'],
    icon: CodeIcon,
    checked: devMode,
    set: writeDevMode,
  }
  return { theme: themeSetting, motion: motionSetting, autoOpenOutputs, alwaysShowThinking, developerMode }
}
