import { SettingRow, SettingsGroup, Switch } from '@gadgets/ui'
import { useAttempt } from '../useAttempt'
import { AdminSettingsStatus } from './AdminSettingsStatus'
import { useAdminSettings } from './useAdminSettings'

/** Who may make an account on the deployment, and whether people can be found by name to be invited. */
export const AdminAccessSettings = () => {
  const { state, change } = useAdminSettings()
  const { problem, attempt } = useAttempt()
  return (
    <AdminSettingsStatus state={state}>
      {(view) => (
        <>
          {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
          <SettingsGroup title="People">
            <SettingRow title="Allow new sign-ups" description="When off, people who have an account can still sign in, but no new accounts can be made.">
              <Switch
                aria-label="Allow new sign-ups"
                checked={view.signupsEnabled}
                onCheckedChange={(enabled) => void attempt(enabled ? 'allow new sign-ups' : 'stop new sign-ups', () =>
                  change((shown) => ({ ...shown, signupsEnabled: enabled }), (admin) => admin.setSignupsEnabled(enabled)))}
              />
            </SettingRow>
            <SettingRow title="Allow user search" description="Let people find others by name or email when they share a workspace. When off, someone is only invited by their exact username or email. Applies to each person the next time they connect.">
              <Switch
                aria-label="Allow user search"
                checked={view.userSearchEnabled}
                onCheckedChange={(enabled) => void attempt(enabled ? 'allow user search' : 'turn off user search', () =>
                  change((shown) => ({ ...shown, userSearchEnabled: enabled }), (admin) => admin.setUserSearchEnabled(enabled)))}
              />
            </SettingRow>
          </SettingsGroup>
        </>
      )}
    </AdminSettingsStatus>
  )
}
