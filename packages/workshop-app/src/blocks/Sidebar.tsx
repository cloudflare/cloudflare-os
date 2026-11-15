import { CirclesFourIcon, FolderIcon, MagnifyingGlassIcon, ShieldCheckIcon, SignOutIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton, type ConnectButtonLogo } from '@/components/ConnectButton'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LogoIcon } from '@/components/LogoIcon'
import { WorkspaceNav, type SidebarWorkspace } from './WorkspaceNav'

export type { SidebarWorkspace }

export type SidebarProps = {
  user: { name: string; avatarUrl?: string }
  /** The recents, each drawn with its workspace's icon: chats on rows of their own, or workspaces. */
  workspaces: SidebarWorkspace[]
  /** The `id` of the row that is open. */
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** The logo was clicked: go to the start of a new chat. */
  onGoHome?: () => void
  /** Shown in place of the list when there is nothing to list, e.g. "No workspaces yet." */
  notice?: string
  /** Logos of the connected services, shown in the connect button. */
  connections?: ConnectButtonLogo[]
  /** While nothing is connected: logos of services that could be, shown in grey to invite it. */
  suggestedConnections?: ConnectButtonLogo[]
  /** The connect button's page, of what is connected and what can be, and whether it is the one showing. */
  connectionsPage?: { current: boolean; onOpen: () => void }
  /**
   * The library's page, and whether it is the one showing; `waiting`, how many changes the user's
   * gadgets have waiting on them to approve, which a dot on its button says there are.
   */
  library?: { current: boolean; onOpen: () => void; waiting?: number }
  /** The page listing every workspace, and whether it is the one showing. */
  workspacesPage?: { current: boolean; onOpen: () => void }
  /** The user's profile, from the account menu's first row, and whether it is the one showing. */
  profilePage?: { current: boolean; onOpen: () => void }
  /** Opens search. */
  onSearch?: () => void
  /** Goes to the deployment's admin settings, in the account menu. Only for an admin. */
  onOpenAdmin?: () => void
  /** Signs the user out of this browser. */
  onSignOut?: () => void
  /** Drawn as a rail one button wide: the same buttons in a column, and each workspace's icon. */
  collapsed?: boolean
}

const RailDivider = () => <span aria-hidden="true" className="my-4 h-px w-4 shrink-0 bg-kumo-line" />

/** The sidebar: global buttons on top, the recent chats and workspaces, then the user and connections. */
export const Sidebar = ({
  user,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onGoHome,
  notice,
  connections,
  suggestedConnections,
  connectionsPage,
  library,
  workspacesPage,
  profilePage,
  onSearch,
  onOpenAdmin,
  onSignOut,
  collapsed = false,
}: SidebarProps) => {
  const home = <Button icon={<LogoIcon />} aria-label="Home" onClick={onGoHome} className="[&>svg]:size-[1.5em]" />
  const workspacesButton = (
    <Button
      icon={FolderIcon}
      aria-label="Workspaces"
      aria-current={workspacesPage?.current ? 'page' : undefined}
      onClick={workspacesPage?.onOpen}
      className="aria-[current=page]:bg-kumo-tint"
    />
  )
  const waiting = library?.waiting ?? 0
  const libraryButton = (
    <span className="relative flex">
      <Button
        icon={CirclesFourIcon}
        aria-label={waiting > 0 ? `Library, ${waiting} to approve` : 'Library'}
        title={waiting > 0 ? `${waiting} to approve` : undefined}
        aria-current={library?.current ? 'page' : undefined}
        onClick={library?.onOpen}
        className="aria-[current=page]:bg-kumo-tint"
      />
      {waiting > 0 && (
        <span aria-hidden="true" className="appears pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full bg-kumo-warning ring-2 ring-kumo-canvas" />
      )}
    </span>
  )
  const search = <Button icon={MagnifyingGlassIcon} aria-label="Search" title="Search (⌘K)" aria-haspopup="dialog" onClick={onSearch} />
  // Up from the bottom, and out to the side of the rail, so it opens over the page rather than off it.
  const account = (
    <DropdownMenu icon={<Avatar name={user.name} src={user.avatarUrl} />} aria-label="Account" side={collapsed ? 'right' : 'top'} align={collapsed ? 'end' : 'start'}>
      {profilePage ? (
        <DropdownMenu.Item label={`${user.name}, your profile`} onSelect={profilePage.onOpen} current={profilePage.current}>
          <Avatar name={user.name} src={user.avatarUrl} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{user.name}</span>
            <span className="block text-sm text-kumo-subtle">Your profile</span>
          </span>
        </DropdownMenu.Item>
      ) : (
        <div className="px-3 pt-2 pb-1.5 text-sm text-kumo-subtle">Signed in as <span className="text-kumo-default">{user.name}</span></div>
      )}
      <DropdownMenu.Separator />
      {onOpenAdmin && <DropdownMenu.Item icon={ShieldCheckIcon} onSelect={onOpenAdmin}>Admin</DropdownMenu.Item>}
      <DropdownMenu.Item icon={SignOutIcon} onSelect={onSignOut} disabled={!onSignOut}>Sign out</DropdownMenu.Item>
    </DropdownMenu>
  )
  const nav = (
    <WorkspaceNav
      key={collapsed ? 'rail' : 'list'}
      workspaces={workspaces}
      selectedWorkspaceId={selectedWorkspaceId}
      onSelectWorkspace={onSelectWorkspace}
      notice={notice}
      rail={collapsed}
    />
  )

  if (collapsed) {
    return (
      // As wide as `AppShell`'s rail: a button, with room around it.
      <div className="flex min-h-0 flex-1 flex-col items-center px-2 py-2.5">
        <header className="flex flex-col items-center">
          {home}
          <RailDivider />
          <div className="flex flex-col gap-1.5">
            {search}
            {libraryButton}
            {workspacesButton}
          </div>
          <RailDivider />
        </header>
        {nav}
        <footer className="mt-3 flex flex-col items-center gap-1">
          <ConnectButton current={connectionsPage?.current} onConnect={connectionsPage?.onOpen} />
          {account}
        </footer>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-1.5 py-2.5">
      <header className="flex items-center gap-2">
        <div className="mr-auto flex">{home}</div>
        {workspacesButton}
        {libraryButton}
        {search}
      </header>
      {nav}
      <footer className="flex items-center justify-between">
        {account}
        <ConnectButton logos={connections} suggested={suggestedConnections} current={connectionsPage?.current} onConnect={connectionsPage?.onOpen} />
      </footer>
    </div>
  )
}
