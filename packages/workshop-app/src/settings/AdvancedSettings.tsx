import { Button, ConfirmMenu, SettingRow, SettingsGroup } from '@gadgets/ui'
import { resetLocalPreferences } from './resetLocalPreferences'
import { SettingDefinitionRow } from './SettingDefinitionRow'
import { usePreferenceSettings } from './usePreferenceSettings'

/** Tools for those who build on the app, and what is kept on this device. */
export const AdvancedSettings = () => {
  const { developerMode } = usePreferenceSettings()
  return (
    <>
      <SettingsGroup title="Developer">
        <SettingDefinitionRow setting={developerMode} />
        <SettingRow title="API tokens" description="Access your workspaces from scripts and other apps." soon>
          <Button>Create token</Button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Local data">
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
