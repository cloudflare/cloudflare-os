import type { ReactNode } from 'react'
import { CirclesFourIcon, FolderIcon, MagnifyingGlassIcon, PuzzlePieceIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { LogoIcon } from '@/components/LogoIcon'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'
import { WorkspaceNav, type SidebarWorkspace } from './WorkspaceNav'

export type { SidebarWorkspace }

export type SidebarProps = {
  user: { name: string; avatarUrl?: string }
  workspaces: SidebarWorkspace[]
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** The logo was clicked: go to the start of a new chat. */
  onGoHome?: () => void
  /** Shown in place of the list when there is nothing to list, e.g. "No workspaces yet." */
  notice?: string
  /** Logos of the connected apps, shown in the connect button, which only `icons` has for now. */
  connections?: ReactNode
  /** The library's page, and whether it is the one showing. */
  library?: { current: boolean; onOpen: () => void }
  /** The page listing every workspace, and whether it is the one showing. */
  workspacesPage?: { current: boolean; onOpen: () => void }
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

// The keys a search would open by: Command on Apple's keyboards, Control on any other.
const searchKeys = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K')

type NavRowProps = {
  icon: ReactNode
  label: string
  /** What it is called, where its label alone does not say, such as a user's name. */
  'aria-label'?: string
  current?: boolean
  onClick?: () => void
}

/**
 * A round button with its name beside it. The whole row is the button, filled while pointed at or
 * current, as a workspace's is, with room around the circle: give that room back around the rows
 * (`-m-1.5`), so that the circles stay in line with the buttons over the list. In `NavRows`, the
 * fill is the shared highlight's.
 */
const NavRow = ({ icon, label, current, onClick, ...props }: NavRowProps) => (
  <button
    type="button"
    data-nav-row=""
    aria-current={current ? 'page' : undefined}
    onClick={onClick}
    className={cn(
      // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
      "relative after:absolute after:inset-0 after:content-['']",
      'flex w-full items-center gap-2.5 rounded-2xl p-2.5 pr-4 text-left text-(length:--control-text) font-medium text-kumo-default',
      'not-data-underlay:hover:bg-kumo-fill not-data-underlay:aria-[current=page]:bg-kumo-fill',
    )}
    {...props}
  >
    <span className="grid size-(--control-size) shrink-0 place-items-center rounded-full bg-kumo-base ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
      {icon}
    </span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
  </button>
)

const navUnderlay = 'pointer-events-none absolute inset-x-0 top-0 -z-10 h-0 rounded-2xl bg-kumo-fill'

/** The rows under the list, with one highlight shared between the current row and the one pointed at, as the workspaces have. */
const NavRows = ({ children }: { children: ReactNode }) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay('[data-nav-row]')
  return (
    <footer ref={listRef} className="relative isolate mt-0.5 -mb-1.5 flex flex-col gap-0">
      <div ref={underlayRef} aria-hidden="true" className={navUnderlay} />
      <div ref={hoverUnderlayRef} aria-hidden="true" className={navUnderlay} />
      {children}
    </footer>
  )
}

/** The sidebar: the logo and the global buttons, the workspaces, and the user and connections. */
export const Sidebar = ({
  user,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onGoHome,
  notice,
  connections,
  library,
  workspacesPage,
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
  const libraryButton = (
    <Button
      icon={CirclesFourIcon}
      aria-label="Library"
      aria-current={library?.current ? 'page' : undefined}
      onClick={library?.onOpen}
      className="aria-[current=page]:bg-kumo-tint"
    />
  )
  const search = <Button icon={MagnifyingGlassIcon} aria-label="Search" />
  const account = <Button icon={<Avatar name={user.name} src={user.avatarUrl} />} aria-label="Account" />
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
          <Button icon={PuzzlePieceIcon} aria-label="Connections" />
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
            <Button icon={MagnifyingGlassIcon} aria-label="Search">
              <kbd className="font-sans font-normal text-kumo-subtle">{searchKeys()}</kbd>
            </Button>
          )}
        </header>
        {nav}
        <NavRows>
          <NavRow icon={<FolderIcon />} label="Workspaces" current={workspacesPage?.current} onClick={workspacesPage?.onOpen} />
          <NavRow icon={<CirclesFourIcon />} label="Library" current={library?.current} onClick={library?.onOpen} />
          <NavRow icon={<PuzzlePieceIcon />} label="Connections" />
          <NavRow icon={<Avatar name={user.name} src={user.avatarUrl} />} label={user.name} aria-label={`Account, ${user.name}`} />
        </NavRows>
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
          <ConnectButton />
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
        <ConnectButton>{connections}</ConnectButton>
      </footer>
    </div>
  )
}
