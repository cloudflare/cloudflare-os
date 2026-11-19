import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
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
