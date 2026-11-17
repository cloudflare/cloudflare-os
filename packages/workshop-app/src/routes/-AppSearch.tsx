import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CirclesFourIcon, FolderIcon, GearIcon, NotePencilIcon, PuzzlePieceIcon, StorefrontIcon } from '@phosphor-icons/react'
import { SearchDialog, type SearchEntry } from '@/blocks/SearchDialog'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { formatActivity } from '@/workspaces/formatActivity'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'

// The most recently active, offered before anything is typed.
const SUGGESTED_WORKSPACES = 4

/**
 * Search, from the sidebar or ⌘K (Ctrl+K) anywhere: the app's own pages and every workspace, from
 * the list the sidebar already has, so opening it reads nothing.
 */
export const AppSearch = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const navigate = useNavigate()
  const workspaces = useWorkspaces()
  const looks = useWorkspaceLooks()

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
  const pages: SearchEntry[] = [
    { key: 'new-chat', group: 'Go to', title: 'New chat', keywords: ['home', 'start'], icon: <NotePencilIcon />, onSelect: () => void navigate({ to: '/' }) },
    { key: 'workspaces', group: 'Go to', title: 'Workspaces', icon: <FolderIcon />, onSelect: () => void navigate({ to: '/workspaces' }) },
    { key: 'library', group: 'Go to', title: 'Library', keywords: ['apps', 'gadgets', 'files', 'skills'], icon: <CirclesFourIcon />, onSelect: () => void navigate({ to: '/library' }) },
    { key: 'templates', group: 'Go to', title: 'Templates', keywords: ['store', 'discover', 'blueprints'], icon: <StorefrontIcon />, onSelect: () => void navigate({ to: '/library/templates' }) },
    { key: 'connections', group: 'Go to', title: 'Connections', keywords: ['accounts', 'services'], icon: <PuzzlePieceIcon />, onSelect: () => void navigate({ to: '/connections' }) },
    { key: 'settings', group: 'Go to', title: 'Settings', keywords: ['profile', 'models', 'preferences'], icon: <GearIcon />, onSelect: () => void navigate({ to: '/settings' }) },
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

  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      entries={[...pages, ...listed]}
      suggested={[...listed.slice(0, SUGGESTED_WORKSPACES), ...pages]}
      placeholder="Search workspaces and pages"
    />
  )
}
