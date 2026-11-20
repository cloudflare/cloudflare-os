import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { resetLocalPreferences } from './resetLocalPreferences'
import { SettingDefinitionRow } from './SettingDefinitionRow'
import { usePreferenceSettings } from './usePreferenceSettings'

/**
 * How the app looks and behaves on this device, the tools for those who build on it, and the way
 * to forget all of it, as it is all kept in this browser.
 */
export const PreferenceSettings = () => {
  const { theme, motion, autoOpenOutputs, developerMode } = usePreferenceSettings()
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingDefinitionRow setting={theme} />
        <SettingDefinitionRow setting={motion} />
      </SettingsGroup>
      <SettingsGroup title="Side pane">
        <SettingDefinitionRow setting={autoOpenOutputs} />
      </SettingsGroup>
      <SettingsGroup title="Advanced">
        <SettingDefinitionRow setting={developerMode} />
        <SettingRow
          title="Reset local preferences"
          description="Clear what’s saved in this browser: the layout, list views, stars, workspace icons and theme. Your account isn’t affected and you stay signed in."
        >
          <ConfirmMenu
            label="Reset"
            title="Reset local preferences?"
            description="Stars and workspace icons are saved only in this browser, so they’ll be lost for good."
            confirmLabel="Reset"
            onConfirm={resetLocalPreferences}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
