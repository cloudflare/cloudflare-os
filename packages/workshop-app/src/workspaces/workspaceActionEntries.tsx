import { PencilEdit02Icon, UserAdd01Icon } from '@/components/icons'
import type { SearchEntry } from '@/blocks/SearchDialog'

/**
 * What search can do where the user is, in a workspace's chat or on its page, which is not what it
 * does everywhere: a new chat in the workspace, which is not what New chat does (that starts a
 * workspace of its own), and inviting people to it. Each says which workspace at its end, and is
 * there only where it is given, as the viewer may not do either in every workspace. They only add:
 * found by typing too, and nothing found elsewhere is left out for being here.
 */
export const workspaceActionEntries = ({ workspaceTitle, onNewChat, onInvite }: {
  /** What the workspace is called, where that is known. */
  workspaceTitle: string | undefined
  onNewChat: (() => void) | undefined
  onInvite: (() => void) | undefined
}): { newChat: SearchEntry | undefined; invite: SearchEntry | undefined } => ({
  newChat: onNewChat && {
    key: 'workspace:new-chat',
    group: 'Go to',
    title: 'New chat',
    keywords: ['start', 'chat', 'here'],
    detail: workspaceTitle,
    icon: <PencilEdit02Icon />,
    onSelect: onNewChat,
  },
  invite: onInvite && {
    key: 'workspace:invite',
    group: 'Workspace',
    title: 'Invite',
    keywords: ['share', 'people', 'members', 'collaborate', 'access', 'add', 'workspace'],
    detail: workspaceTitle,
    icon: <UserAdd01Icon />,
    onSelect: onInvite,
  },
})
