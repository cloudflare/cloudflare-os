import { useState } from 'react'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'
import { useMotionLevel } from '@/hooks/useMotionLevel'
import { readTheme, writeTheme, type Theme } from '@/prefs/appearance'
import { readLayoutPrefs, writeLayoutPrefs } from '@/prefs/layoutPrefs'
import { writeMotionLevel, type MotionLevel } from '@/prefs/motion'
import { SoonSelect } from './SoonControls'

const THEME_OPTIONS: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

const MOTION_OPTIONS: { id: MotionLevel; label: string }[] = [
  { id: 'full', label: 'Full' },
  { id: 'calm', label: 'Calm' },
  { id: 'off', label: 'Off' },
]

/** How the app looks and behaves on this device. */
export const PreferenceSettings = () => {
  const [theme, setTheme] = useState(readTheme)
  const motion = useMotionLevel()
  const [opensNewOutputs, setOpensNewOutputs] = useState(() => readLayoutPrefs().opensNewOutputs !== false)
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingRow title="Theme" description="Follows your system unless you choose. Saved in this browser.">
          <Select
            aria-label="Theme"
            value={theme}
            options={THEME_OPTIONS}
            onValueChange={(next) => {
              writeTheme(next)
              setTheme(next)
            }}
          />
        </SettingRow>
        <SettingRow title="Accent color" description="The color of selections and primary actions." soon>
          <SoonSelect label="Accent color" options={[{ id: 'default', label: 'Deployment default' }, { id: 'orange', label: 'Orange' }, { id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }, { id: 'purple', label: 'Purple' }]} />
        </SettingRow>
        <SettingRow title="Text size" description="The size of text in conversations." soon>
          <SoonSelect label="Text size" value="default" options={[{ id: 'small', label: 'Small' }, { id: 'default', label: 'Default' }, { id: 'large', label: 'Large' }]} />
        </SettingRow>
        <SettingRow title="Animations" description="Follows your system unless you choose. Saved in this browser.">
          <Select aria-label="Animations" value={motion} options={MOTION_OPTIONS} onValueChange={writeMotionLevel} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Side pane">
        <SettingRow title="Auto-open outputs" description="Open apps, documents and other outputs in the side pane as soon as the assistant creates them. Saved in this browser.">
          <Switch
            aria-label="Auto-open outputs"
            checked={opensNewOutputs}
            onCheckedChange={(next) => {
              writeLayoutPrefs({ opensNewOutputs: next })
              setOpensNewOutputs(next)
            }}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Keyboard" soon>
        <SettingRow title="Keyboard shortcuts" description="View and customize keyboard shortcuts.">
          <Button>View shortcuts</Button>
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
