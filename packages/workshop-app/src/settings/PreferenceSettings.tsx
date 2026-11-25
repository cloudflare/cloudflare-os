import { ConfirmMenu, SettingRow, SettingsGroup } from '@gadgets/ui'
import { resetLocalPreferences } from './resetLocalPreferences'
import { SettingDefinitionRow } from './SettingDefinitionRow'
import { usePreferenceSettings } from './usePreferenceSettings'

/**
 * How the app looks and behaves on this device, the tools for those who build on it, and the way
 * to forget all of it, as it is all kept in this browser.
 */
export const PreferenceSettings = () => {
  const { theme, motion, autoOpenOutputs, alwaysShowThinking, developerMode } = usePreferenceSettings()
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingDefinitionRow setting={theme} />
        <SettingDefinitionRow setting={motion} />
      </SettingsGroup>
      <SettingsGroup title="Chat">
        <SettingDefinitionRow setting={alwaysShowThinking} />
      </SettingsGroup>
      <SettingsGroup title="Side pane">
        <SettingDefinitionRow setting={autoOpenOutputs} />
      </SettingsGroup>
      <SettingsGroup title="Advanced">
        <SettingDefinitionRow setting={developerMode} />
        <SettingRow
          title="Reset local preferences"
          description="Clear what’s saved in this browser: the layout, list views and theme. Your account isn’t affected and you stay signed in."
        >
          <ConfirmMenu
            label="Reset"
            title="Reset local preferences?"
            description="This browser’s layout, list views and theme go back to how they start."
            confirmLabel="Reset"
            onConfirm={resetLocalPreferences}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
