import { BrowserNotificationsRow } from '@/blocks/BrowserNotificationsRow'
import { MutedWorkspaces } from '@/blocks/MutedWorkspaces'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { useBrowserPushSetting } from '@/notifications/useBrowserPush'
import { useSetWorkspaceMuted, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'
import { isWorkspaceMuted } from '@/workspaces/workspaceMute'
import { useAttempt } from './useAttempt'

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
  // As it is drawn everywhere else.
  const listed = ({ id, title }: { id: string; title: string }) => ({ id, title: workspaceTitle({ title }), label: workspaceLabel(title), look: looks[id] })

  return (
    <>
      {/* Only where the deployment and this browser can have them. */}
      {browser.available && (
        <SettingsGroup title="This browser">
          <BrowserNotificationsRow
            state={browser.support === 'supported' || browser.support === 'unsupported' ? browser.status : browser.support}
            pending={browser.pending}
            problem={pushAttempt.problem}
            onChange={(on) => void pushAttempt.attempt(on ? 'turn on browser notifications' : 'turn off browser notifications', () => browser.setOn(on))}
          />
        </SettingsGroup>
      )}
      <MutedWorkspaces
        title="Muted workspaces"
        description="A muted workspace doesn’t notify you when tasks finish. Approval requests still come through."
        muted={workspaces.filter(isWorkspaceMuted).map(({ notificationMute: mute, ...workspace }) => ({ ...listed(workspace), until: mute?.until && `Until ${UNTIL.format(mute.until)}` }))}
        others={workspaces.filter((workspace) => !isWorkspaceMuted(workspace)).map(listed)}
        loading={workspacesState.status === 'loading'}
        failure={workspacesState.status === 'failed' ? workspacesState.message : undefined}
        problem={problem}
        onMute={(id) => void attempt('mute the workspace', () => setMuted(id, true))}
        onUnmute={(id) => void attempt('unmute the workspace', () => setMuted(id, false))}
      />
    </>
  )
}
