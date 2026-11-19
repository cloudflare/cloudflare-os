import { BellIcon, BellSlashIcon } from '@phosphor-icons/react'
import type { SearchEntry } from '@/blocks/SearchDialog'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useBrowserPushSetting } from '@/notifications/useBrowserPush'
import { useSetWorkspaceMuted, useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { workspaceTitle } from '@/workspaces/workspaceList'
import { isWorkspaceMuted } from '@/workspaces/workspaceMute'
import { useRequireConnection } from './useRequireConnection'

const GROUP = 'Notifications'

// What is said before its switch, where there is something besides on or off to say.
const BROWSER_DETAIL = { loading: 'Checking…', on: undefined, off: undefined, blocked: 'Blocked' } as const

/**
 * The Notifications settings that are there: this browser's, where it can have them, and each
 * workspace's mute, chosen from the workspaces in a page of their own.
 */
export const useNotificationEntries = (): SearchEntry[] => {
  const browser = useBrowserPushSetting()
  const workspacesState = useWorkspaces()
  const looks = useWorkspaceLooks()
  const setMuted = useSetWorkspaceMuted()
  const requireConnection = useRequireConnection()

  const workspaces = workspacesState.status === 'ready' ? workspacesState.workspaces : []
  const muted = workspaces.filter(isWorkspaceMuted)
  const others = workspaces.filter((workspace) => !isWorkspaceMuted(workspace))

  const choices = (from: typeof workspaces, to: boolean): SearchEntry[] =>
    from.map(({ id, title }) => ({
      key: `setting:${to ? 'mute' : 'unmute'}:${id}`,
      group: 'Workspaces',
      title: workspaceTitle({ title }),
      icon: <WorkspaceIcon label={workspaceLabel(title)} {...looks[id]} small />,
      onSelect: () => {
        requireConnection()
        return setMuted(id, to)
      },
    }))

  return [
    ...(browser.available && browser.support === 'supported'
      ? [{
          key: 'setting:browser-notifications',
          group: GROUP,
          title: 'Browser notifications',
          keywords: ['push', 'alerts', 'tasks', 'approvals'],
          detail: BROWSER_DETAIL[browser.status],
          on: browser.status === 'on',
          icon: browser.status === 'on' ? <BellIcon weight="fill" /> : <BellIcon />,
          keepOpen: true,
          onSelect: () => {
            if (browser.pending || browser.status === 'loading') return
            if (browser.status === 'blocked') throw new Error('Notifications are blocked for this site in your browser’s settings.')
            requireConnection()
            // Called now, so that the browser's question still has the click.
            return browser.setOn(browser.status !== 'on')
          },
        } satisfies SearchEntry]
      : []),
    ...(others.length > 0
      ? [{
          key: 'setting:mute-workspace',
          group: GROUP,
          title: 'Mute workspace…',
          keywords: ['notifications', 'quiet', 'silence'],
          icon: <BellSlashIcon />,
          onSelect: () => ({ kind: 'list', title: 'Mute workspace', placeholder: 'Find a workspace to mute', entries: choices(others, true) }),
        } satisfies SearchEntry]
      : []),
    ...(muted.length > 0
      ? [{
          key: 'setting:unmute-workspace',
          group: GROUP,
          title: 'Unmute workspace…',
          keywords: ['notifications', 'quiet', 'silence'],
          detail: `${muted.length} muted`,
          icon: <BellIcon />,
          onSelect: () => ({ kind: 'list', title: 'Unmute workspace', placeholder: 'Find a workspace to unmute', entries: choices(muted, false) }),
        } satisfies SearchEntry]
      : []),
  ]
}
