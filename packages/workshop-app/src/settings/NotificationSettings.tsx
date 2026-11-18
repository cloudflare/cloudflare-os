import { BrowserNotificationsRow } from '@/blocks/BrowserNotificationsRow'
import { MutedWorkspaces } from '@/blocks/MutedWorkspaces'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { useBrowserPushSetting } from '@/notifications/useBrowserPush'
import { useSetWorkspaceMuted, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'
import { useAttempt } from './useAttempt'
import { SoonSelect, SoonSwitch } from './SoonControls'

const UNTIL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * What the user is told of, and where: this browser, where the deployment and the browser can
 * have it, and the workspaces that are kept quiet. While the Workshop is in view, a task is told
 * of at the top of the window instead (`TaskNotices`).
 */
export const NotificationSettings = () => {
  const workspacesState = useWorkspaces()
  const looks = useWorkspaceLooks()
  const setMuted = useSetWorkspaceMuted()
  const { problem, attempt } = useAttempt()
  const browser = useBrowserPushSetting()
  const pushAttempt = useAttempt()

  const workspaces = workspacesState.status === 'ready' ? workspacesState.workspaces : []
  // A mute that has run out is no longer one.
  const isMuted = ({ notificationMute: mute }: (typeof workspaces)[number]) => mute !== undefined && (mute.indefinite === true || mute.until.getTime() > Date.now())
  // As it is drawn everywhere else.
  const listed = ({ id, title }: { id: string; title: string }) => ({ id, title: workspaceTitle({ title }), label: workspaceLabel(title), look: looks[id] })

  return (
    <>
      <SettingsGroup title="Channels">
        {browser.available && (
          <BrowserNotificationsRow
            state={browser.support === 'supported' || browser.support === 'unsupported' ? browser.status : browser.support}
            pending={browser.pending}
            problem={pushAttempt.problem}
            onChange={(on) => void pushAttempt.attempt(on ? 'turn on browser notifications' : 'turn off browser notifications', () => browser.setOn(on))}
          />
        )}
        <SettingRow title="Notification sound" description="Play a sound when a task finishes or needs your approval." soon>
          <SoonSwitch label="Notification sound" />
        </SettingRow>
        <SettingRow title="Email digest" description="A summary of what happened while you were away." soon>
          <SoonSelect label="Email digest" options={[{ id: 'never', label: 'Never' }, { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }]} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Notify me about" soon>
        <SettingRow title="Finished tasks" description="When the assistant finishes a task.">
          <SoonSwitch label="Finished tasks" on />
        </SettingRow>
        <SettingRow title="Approval requests" description="When an action or a connection request needs your approval.">
          <SoonSwitch label="Approval requests" on />
        </SettingRow>
        <SettingRow title="Workspace activity" description="When someone joins or sends a message in a shared workspace.">
          <SoonSwitch label="Workspace activity" />
        </SettingRow>
      </SettingsGroup>
      <MutedWorkspaces
        title="Muted workspaces"
        description="A muted workspace doesn’t notify you when tasks finish. Approval requests still come through."
        muted={workspaces.filter(isMuted).map(({ notificationMute: mute, ...workspace }) => ({ ...listed(workspace), until: mute?.until && `Until ${UNTIL.format(mute.until)}` }))}
        others={workspaces.filter((workspace) => !isMuted(workspace)).map(listed)}
        loading={workspacesState.status === 'loading'}
        failure={workspacesState.status === 'failed' ? workspacesState.message : undefined}
        problem={problem}
        onMute={(id) => void attempt('mute the workspace', () => setMuted(id, true))}
        onUnmute={(id) => void attempt('unmute the workspace', () => setMuted(id, false))}
      />
    </>
  )
}
