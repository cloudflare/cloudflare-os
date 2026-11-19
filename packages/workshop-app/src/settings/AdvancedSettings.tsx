import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { resetLocalPreferences } from './resetLocalPreferences'
import { SoonSwitch } from './SoonControls'

/** Tools for those who build on the app, and what is kept on this device. */
export const AdvancedSettings = () => (
  <>
    <SettingsGroup title="Developer" soon>
      <SettingRow title="Developer mode" description="Show tool calls, token usage and timing in message details.">
        <SoonSwitch label="Developer mode" />
      </SettingRow>
      <SettingRow title="API tokens" description="Access your workspaces from scripts and other apps.">
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
