import { useEffect } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { CirclesFourIcon, FolderIcon, GearIcon, LightningIcon, NotePencilIcon, PuzzlePieceIcon, StorefrontIcon } from '@phosphor-icons/react'
import { SearchDialog, type SearchEntry } from '@/blocks/SearchDialog'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { outputPage } from '@/aside/asideItems'
import { useApi } from '@/rpc/ApiContext'
import { connectionEntries } from '@/connections/connectionEntries'
import type { Connection } from '@/connections/connectionList'
import { libraryEntries } from '@/library/libraryEntries'
import { useLibrary } from '@/library/useLibrary'
import { useSettingsSearchEntries } from '@/settings/search/useSettingsSearchEntries'
import type { SettingsSection } from '@/settings/settingsSections'
import { shareStanding } from '@/workspaces/sharingRules'
import { workspaceActionEntries } from '@/workspaces/workspaceActionEntries'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { formatActivity } from '@/workspaces/formatActivity'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { suggestedEntries, type SuggestedContext } from './-appSearchSuggestions'

/**
 * Search, from the sidebar or ⌘K (Ctrl+K) anywhere: the app's own pages and every workspace, from
 * the list the sidebar already has, the connections, the settings that can be changed in place, and
 * everything the user has made, so that it is a control panel as well. What the settings and the
 * library need read from the server is read as it opens.
 */
/**
 * Where the user is, if that is in a workspace's chat or on its page: what search can do there, which
 * it cannot elsewhere. The page's own ways to do it are given, as they carry what is shown beside it.
 */
export type SearchContext = { workspaceId: string; onNewChat: () => void } & ({ kind: 'chat' } | { kind: 'workspace'; onInvite: () => void })

export const AppSearch = ({ open, onOpenChange, connections, context }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the sidebar has already read of the services, so that offering them reads nothing. */
  connections: readonly Connection[]
  context: SearchContext | undefined
}) => {
  const navigate = useNavigate()
  const { user } = useApi()
  const workspaces = useWorkspaces()
  const looks = useWorkspaceLooks()
  const inSettings = useRouterState({ select: ({ location }) => location.pathname.startsWith('/settings') })
  // Where a chat is started already, home or a workspace's new chat, so that another is not offered there.
  const startsChat = useRouterState({ select: ({ location }) => location.pathname === '/' || /^\/workspace\/[^/]+\/new\/?$/.test(location.pathname) })
  // As the sidebar's own parts do: in place where the settings are open already, so that going back leaves them.
  const openSection = (section: SettingsSection) =>
    void navigate(inSettings ? { to: '/settings', search: { section }, replace: true, state: true } : { to: '/settings', search: { section }, state: { settingsOpenedHere: true } })
  const settings = useSettingsSearchEntries(open, openSection)
  // Everything the user has made, found by typing, read as search opens, as the models are, so that
  // nothing is asked for before it is wanted; what was read stays while it is shut.
  const library = useLibrary(open ? 'search' : null)
  const made = libraryEntries(library.status === 'ready' ? library.outputs : [], (output) => void navigate(outputPage(output)))
  // Each opens its own dialog on the Connections page, which is where what a service is given access to is chosen.
  const connect = connectionEntries(connections, (key) => void navigate({ to: '/connections', search: { open: key } }))

  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      onOpenChange(!open)
    }
    window.addEventListener('keydown', pressed)
    return () => window.removeEventListener('keydown', pressed)
  }, [open, onOpenChange])

  // With the icons the sidebar gives them, so each is known by it here too.
  // Those gone to most, which are offered before anything is typed.
  const mainPages: SearchEntry[] = [
    { key: 'workspaces', group: 'Go to', title: 'Workspaces', icon: <FolderIcon />, onSelect: () => void navigate({ to: '/workspaces' }) },
    { key: 'library', group: 'Go to', title: 'Library', keywords: ['apps', 'gadgets', 'files', 'skills'], icon: <CirclesFourIcon />, onSelect: () => void navigate({ to: '/library' }) },
    { key: 'automations', group: 'Go to', title: 'Automations', keywords: ['scheduled tasks', 'schedules', 'triggers', 'hooks'], icon: <LightningIcon />, onSelect: () => void navigate({ to: '/automations' }) },
  ]
  // The first of what is offered before anything is typed, where there is nothing nearer to start one in.
  const newChatPage: SearchEntry = { key: 'new-chat', group: 'Go to', title: 'New chat', keywords: ['home', 'start'], icon: <NotePencilIcon />, onSelect: () => void navigate({ to: '/' }) }
  // Offered with the settings that are reached for, as the way to the rest of them.
  const settingsPage: SearchEntry = { key: 'settings', group: 'Go to', title: 'Settings', keywords: ['profile', 'models', 'preferences'], icon: <GearIcon />, onSelect: () => void navigate({ to: '/settings' }) }
  // Found by typing.
  const morePages: SearchEntry[] = [
    { key: 'templates', group: 'Go to', title: 'Templates', keywords: ['store', 'discover', 'blueprints'], icon: <StorefrontIcon />, onSelect: () => void navigate({ to: '/library/templates' }) },
    { key: 'connections', group: 'Go to', title: 'Connections', keywords: ['accounts', 'services'], icon: <PuzzlePieceIcon />, onSelect: () => void navigate({ to: '/connections' }) },
  ]
  // Most recently active first, as the provider keeps them.
  const listed: SearchEntry[] = workspaces.status === 'ready'
    ? workspaces.workspaces.map(({ id, title, lastActive }) => ({
        key: `workspace:${id}`,
        group: 'Workspaces',
        title: title || 'Untitled workspace',
        detail: formatActivity(lastActive),
        // Drawn as the sidebar draws it, with the look it was given.
        icon: <WorkspaceIcon label={workspaceLabel(title)} {...looks[id]} small />,
        onSelect: () => void navigate({ to: '/workspace/$workspaceId', params: { workspaceId: id } }),
      }))
    : []

  // Where the user is, in a workspace's chat or on its page: what is done there is added to what is
  // found everywhere, and comes first among equals. Each only where the viewer may.
  const here: SuggestedContext | undefined = context && (() => {
    const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === context.workspaceId) : undefined
    // Until the workspace is in the list, a chat is one the viewer builds in, and its page is not asked.
    const mayBuild = workspace ? workspace.role !== 'use' : context.kind === 'chat'
    const mayInvite = workspace !== undefined && shareStanding(workspace, user).canShare
    return {
      kind: context.kind,
      ...workspaceActionEntries({
        workspaceTitle: workspace?.title || undefined,
        onNewChat: mayBuild ? context.onNewChat : undefined,
        onInvite: context.kind === 'workspace' && mayInvite ? context.onInvite : undefined,
      }),
    }
  })()

  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      entries={[...(here ? [here.newChat, here.invite].filter((entry) => entry !== undefined) : []), newChatPage, ...mainPages, settingsPage, ...morePages, ...listed, ...made, ...settings.entries, ...connect]}
      suggested={suggestedEntries({
        workspaces: listed,
        pages: mainPages,
        newChat: startsChat ? undefined : newChatPage,
        model: settings.suggested.model,
        settings: [...settings.suggested.settings, settingsPage],
        context: here,
      })}
      reading={open && library.status === 'loading'}
      placeholder="Search workspaces, library, pages and settings"
    />
  )
}
