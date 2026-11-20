import { Button, SettingRow, SettingsGroup } from '@gadgets/ui'
import { SettingDefinitionRow } from './SettingDefinitionRow'
import { SoonSelect } from './SoonControls'
import { usePreferenceSettings } from './usePreferenceSettings'

/** How the app looks and behaves on this device. */
export const PreferenceSettings = () => {
  const { theme, motion, autoOpenOutputs } = usePreferenceSettings()
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingDefinitionRow setting={theme} />
        <SettingRow title="Accent color" description="The color of selections and primary actions." soon>
          <SoonSelect label="Accent color" options={[{ id: 'default', label: 'Deployment default' }, { id: 'orange', label: 'Orange' }, { id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }, { id: 'purple', label: 'Purple' }]} />
        </SettingRow>
        <SettingRow title="Text size" description="The size of text in conversations." soon>
          <SoonSelect label="Text size" value="default" options={[{ id: 'small', label: 'Small' }, { id: 'default', label: 'Default' }, { id: 'large', label: 'Large' }]} />
        </SettingRow>
        <SettingDefinitionRow setting={motion} />
      </SettingsGroup>
      <SettingsGroup title="Side pane">
        <SettingDefinitionRow setting={autoOpenOutputs} />
      </SettingsGroup>
      <SettingsGroup title="Keyboard" soon>
        <SettingRow title="Keyboard shortcuts" description="View and customize keyboard shortcuts.">
          <Button>View shortcuts</Button>
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
