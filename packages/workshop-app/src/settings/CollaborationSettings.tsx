import { SettingRow, SettingsGroup } from '@gadgets/ui'
import { SoonSelect, SoonSwitch } from './SoonControls'

/**
 * How the user is found and seen by those they work with. Who has access to a workspace is set
 * on the workspace's own page, and what is accepted or approved for others is with the approvals;
 * what is here would hold for every workspace, and none of it is there yet.
 */
export const CollaborationSettings = () => (
  <>
    <SettingsGroup title="Invitations" soon>
      <SettingRow title="Default role" description="The role people get when you invite them. You can change it for each member.">
        <SoonSelect label="Default role" options={[{ id: 'build', label: 'Can build' }, { id: 'use', label: 'Can use' }]} />
      </SettingRow>
      <SettingRow title="Discoverability" description="Who can find you by name when inviting people to a workspace.">
        <SoonSelect label="Discoverability" options={[{ id: 'everyone', label: 'Everyone' }, { id: 'collaborators', label: 'People I work with' }, { id: 'no-one', label: 'No one' }]} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Presence" soon>
      <SettingRow title="Show when I’m active" description="Let others see that you’re there while you have a workspace open.">
        <SoonSwitch label="Show when I’m active" on />
      </SettingRow>
    </SettingsGroup>
  </>
)
