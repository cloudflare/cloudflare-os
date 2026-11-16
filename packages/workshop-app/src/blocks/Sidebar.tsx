import type { ReactNode } from 'react'
import { CirclesFourIcon, FolderIcon, MagnifyingGlassIcon, PuzzlePieceIcon, ShieldCheckIcon, SignOutIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton, type ConnectButtonLogo } from '@/components/ConnectButton'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LogoIcon } from '@/components/LogoIcon'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
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
  /** Logos of the connected services, shown in the connect button, which only `icons` has. */
  connections?: ConnectButtonLogo[]
  /** While nothing is connected: logos of services that could be, shown in grey to invite it. */
  suggestedConnections?: ConnectButtonLogo[]
  /** The page of what is connected and what can be, and whether it is the one showing. */
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
  /**
   * Where the pages' buttons are. `rows`, as the app has them: under the list, each with its name,
   * then connections and the user, which leaves the logo and search over it. `icons`, as it had
   * them: beside the logo, as icons, with the user and connections under the list. Kept to compare
   * the two, until one is chosen and the other removed.
   */
  layout?: 'icons' | 'rows'
}

const RailDivider = () => <span aria-hidden="true" className="my-4 h-px w-4 shrink-0 bg-kumo-line" />

// The keys a search opens by: Command on Apple's keyboards, Control on any other.
const searchKeys = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K')

// A dot at a button's corner while changes wait on the user, as the unread dot marks a workspace.
const WaitingDot = () => (
  <span aria-hidden="true" className="appears pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full bg-kumo-warning ring-2 ring-kumo-canvas" />
)

// The circle a row's icon is in, as a button's over the list is.
const ROW_CIRCLE = 'relative grid size-(--control-size) shrink-0 place-items-center rounded-full bg-kumo-base ring-1 ring-kumo-line [&>svg]:size-[1.125em]'
const ROW = 'flex w-full items-center gap-2.5 rounded-full p-1.5 pr-4 text-left text-(length:--control-text) font-medium text-kumo-default hover:bg-kumo-fill aria-[current=page]:bg-kumo-fill'

type NavRowProps = {
  icon: ReactNode
  label: string
  /** What it is called, where its label alone does not say, such as a user's name. */
  'aria-label'?: string
  title?: string
  current?: boolean
  /** Something waits there, which a dot on its circle says. */
  dot?: boolean
  onClick?: () => void
}

/**
 * A round button with its name beside it. The whole row is the button, filled while pointed at or
 * current, as a workspace's is, with room around the circle: give that room back around the rows
 * (`-m-1.5`), so that the circles stay in line with the buttons over the list.
 */
const NavRow = ({ icon, label, current, dot, onClick, ...props }: NavRowProps) => (
  <button type="button" aria-current={current ? 'page' : undefined} onClick={onClick} className={ROW} {...props}>
    <span className={ROW_CIRCLE}>
      {icon}
      {dot && <WaitingDot />}
    </span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
)

/** The sidebar: the logo and search, the recents, then the pages, connections and the user. */
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
  layout = 'rows',
}: SidebarProps) => {
  const narrow = useNarrowScreen()
  const rows = layout === 'rows'
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
  const libraryLabel = waiting > 0 ? `Library, ${waiting} to approve` : 'Library'
  const libraryTitle = waiting > 0 ? `${waiting} to approve` : undefined
  const libraryButton = (
    <span className="relative flex">
      <Button
        icon={CirclesFourIcon}
        aria-label={libraryLabel}
        title={libraryTitle}
        aria-current={library?.current ? 'page' : undefined}
        onClick={library?.onOpen}
        className="aria-[current=page]:bg-kumo-tint"
      />
      {waiting > 0 && <WaitingDot />}
    </span>
  )
  const search = <Button icon={MagnifyingGlassIcon} aria-label="Search" title={`Search (${searchKeys()})`} aria-haspopup="dialog" onClick={onSearch} />
  const gatekeepersButton = (
    <Button
      icon={PuzzlePieceIcon}
      aria-label="Gatekeepers"
      aria-current={connectionsPage?.current ? 'page' : undefined}
      onClick={connectionsPage?.onOpen}
      className="aria-[current=page]:bg-kumo-tint"
    />
  )
  const menu = (
    <>
      {profilePage ? (
        <DropdownMenu.Item label={`${user.name}, your profile`} onSelect={profilePage.onOpen} current={profilePage.current}>
          <Avatar name={user.name} src={user.avatarUrl} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{user.name}</span>
            <span className="block text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">Your profile</span>
          </span>
        </DropdownMenu.Item>
      ) : (
        <DropdownMenu.Label>Signed in as <span className="text-kumo-default">{user.name}</span></DropdownMenu.Label>
      )}
      <DropdownMenu.Separator />
      {onOpenAdmin && <DropdownMenu.Item icon={ShieldCheckIcon} onSelect={onOpenAdmin}>Admin</DropdownMenu.Item>}
      <DropdownMenu.Item icon={SignOutIcon} onSelect={onSignOut} disabled={!onSignOut}>Sign out</DropdownMenu.Item>
    </>
  )
  // Up from the bottom, and out to the side of the rail, so it opens over the page rather than off it.
  const account = (
    <DropdownMenu icon={<Avatar name={user.name} src={user.avatarUrl} />} aria-label="Account" side={collapsed ? 'right' : 'top'} align={collapsed ? 'end' : 'start'}>
      {menu}
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
      fades={rows}
    />
  )

  if (rows && collapsed) {
    return (
      // As wide as `AppShell`'s rail: a button, with room around it.
      <div className="flex min-h-0 flex-1 flex-col items-center px-2 py-2.5">
        <header className="flex flex-col items-center">
          <div className="flex flex-col gap-1.5">
            {home}
            {search}
          </div>
          <RailDivider />
        </header>
        {nav}
        <footer className="mt-5 flex flex-col items-center gap-1.5">
          {workspacesButton}
          {libraryButton}
          {gatekeepersButton}
          {account}
        </footer>
      </div>
    )
  }

  if (rows) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-1.5 py-2.5">
        <header className="flex items-center justify-between">
          {home}
          {/* A keyboard's shortcut says nothing on a phone. */}
          {narrow ? search : (
            <Button icon={MagnifyingGlassIcon} aria-label="Search" aria-haspopup="dialog" onClick={onSearch}>
              <kbd className="font-sans font-normal text-kumo-subtle">{searchKeys()}</kbd>
            </Button>
          )}
        </header>
        {nav}
        <footer className="-mx-1.5 mt-0.5 -mb-1.5 flex flex-col gap-0.5">
          <NavRow icon={<FolderIcon />} label="Workspaces" current={workspacesPage?.current} onClick={workspacesPage?.onOpen} />
          <NavRow icon={<CirclesFourIcon />} label="Library" aria-label={libraryLabel} title={libraryTitle} dot={waiting > 0} current={library?.current} onClick={library?.onOpen} />
          <NavRow icon={<PuzzlePieceIcon />} label="Gatekeepers" current={connectionsPage?.current} onClick={connectionsPage?.onOpen} />
          {/* The user's row opens the account menu in its place, growing up out of the row. */}
          <DropdownMenu
            label={<span className="min-w-0 flex-1 truncate text-start">{user.name}</span>}
            icon={<span className={ROW_CIRCLE}><Avatar name={user.name} src={user.avatarUrl} /></span>}
            aria-label={`Account, ${user.name}`}
            triggerVariant="ghost"
            triggerClassName={`${ROW} h-auto justify-start`}
            side="top"
            // From its middle: from its start, so near the window's edge, it would be pushed to its end.
            align="center"
            inPlace
          >
            {menu}
          </DropdownMenu>
        </footer>
      </div>
    )
  }

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
