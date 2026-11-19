import type { ReactNode } from 'react'
import { CirclesFourIcon, FolderIcon, GearIcon, LightningIcon, MagnifyingGlassIcon, PuzzlePieceIcon, SignOutIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LogoIcon } from '@/components/LogoIcon'
import { Markdown } from '@/components/Markdown'
import { ServiceLogo } from '@/components/ServiceLogo'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'
import { WorkspaceNav, type SidebarWorkspace } from './WorkspaceNav'

export type { SidebarWorkspace }

/** A service as the connect button shows it. */
export type SidebarConnection = {
  name: string
  logoUrl?: string
  /** Its logo is much wider than it is tall, and is drawn a little larger for it. */
  wide?: boolean
}

export type SidebarProps = {
  user: { name: string; avatarUrl?: string }
  workspaces: SidebarWorkspace[]
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** The logo was clicked: go to the start of a new chat. */
  onGoHome?: () => void
  /** The deployment's own logo, in place of the app's mark. */
  logoUrl?: string
  /**
   * What the deployment says to everyone (`ServerConfig.announcement`), as Markdown, under the
   * logo while there is room for it: not on the rail.
   */
  announcement?: string
  /** Shown in place of the list when there is nothing to list, e.g. "No workspaces yet." */
  notice?: string
  /** The services whose logos the connect button shows beside its plus: those connected, or a few to start with. */
  connections?: SidebarConnection[]
  /**
   * The library's page, and whether it is the one showing, with how many things the user's
   * gadgets ask that wait on them (`waiting`), which it marks.
   */
  library?: { current: boolean; onOpen: () => void; waiting?: number }
  /** The page listing every workspace, and whether it is the one showing. */
  workspacesPage?: { current: boolean; onOpen: () => void }
  /** The page listing everything that runs by itself, across workspaces, and whether it is the one showing. */
  automationsPage?: { current: boolean; onOpen: () => void }
  /** The page listing what is connected and what could be, and whether it is the one showing. */
  connectionsPage?: { current: boolean; onOpen: () => void }
  /**
   * The settings' page, which the user's own menu has, and whether it is the one showing. Where
   * there is room for a sidebar beside the page, `SettingsSidebar` takes this one's place while
   * the settings show.
   */
  settingsPage?: { current: boolean; onOpen: () => void }
  /** Signs the user out: the user's own menu has it after the settings, when given. */
  onSignOut?: () => void
  /** Opens search, as ⌘K (Ctrl K) does anywhere. */
  onSearch?: () => void
  /** Drawn as a rail one button wide: the same buttons in a column, and each workspace's icon. */
  collapsed?: boolean
  /**
   * Where the pages' buttons are. `rows`, as the app has them: under the list, each with its name,
   * then the user and connections side by side, which leaves the logo and search over it. `icons`, as it had
   * them: beside the logo, as icons, with the user and connections under the list. Kept to compare
   * the two, until one is chosen and the other removed.
   */
  layout?: 'icons' | 'rows'
}

/** A short line between one stretch of a rail's buttons and the next. */
export const RailDivider = () => <span aria-hidden="true" className="my-4 h-px w-4 shrink-0 bg-kumo-line" />

// The keys a search would open by: Command on Apple's keyboards, Control on any other.
const searchKeys = () => (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K')

type NavRowProps = {
  icon: ReactNode
  label: string
  /** What it is called, where its label alone does not say, such as a user's name. */
  'aria-label'?: string
  current?: boolean
  onClick?: () => void
  /** How many wait on the user there, said at the end of the row. */
  waiting?: number
}

/** What a page's button says of what waits there, as it is read out. */
const waitingLabel = (label: string, waiting = 0) => (waiting > 0 ? `${label}, ${waiting} waiting on you` : undefined)

/** How many wait, as a quiet count in the colour of something to look at. */
const WaitingCount = ({ count, className }: { count: number; className?: string }) => (
  <span aria-hidden="true" className={cn('grid h-5 min-w-5 place-items-center rounded-full bg-kumo-warning-tint px-1.5 text-xs/none font-medium text-kumo-default tabular-nums', className)}>
    {count > 99 ? '99+' : count}
  </span>
)

/**
 * A round button with its name beside it. The whole row is the button, filled while pointed at or
 * current, as a workspace's is, with room around the circle: give that room back around the rows
 * (`-m-1.5`), so that the circles stay in line with the buttons over the list. In `NavRows`, the
 * fill is the shared highlight's.
 */
const NavRow = ({ icon, label, current, onClick, waiting = 0, ...props }: NavRowProps) => (
  <button
    type="button"
    data-nav-row=""
    aria-current={current ? 'page' : undefined}
    onClick={onClick}
    className={cn(
      // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
      "relative after:absolute after:inset-0 after:content-['']",
      'flex w-full cursor-pointer items-center gap-2.5 rounded-2xl p-2 pr-4 text-left text-(length:--control-text) font-medium text-kumo-default',
      'not-data-underlay:hover:bg-kumo-fill not-data-underlay:aria-[current=page]:bg-kumo-fill',
    )}
    {...props}
  >
    <span className="grid size-(--control-size) shrink-0 place-items-center rounded-full bg-kumo-base ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
      {icon}
    </span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {waiting > 0 && <WaitingCount count={waiting} />}
  </button>
)

const navUnderlay = 'pointer-events-none absolute inset-x-0 top-0 -z-10 h-0 rounded-2xl bg-kumo-fill'

/** `NavRow`s, with one highlight shared between the current row and the one pointed at, as the workspaces have. */
const NavRows = ({ children }: { children: ReactNode }) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay('[data-nav-row]')
  return (
    <div ref={listRef} className="relative isolate flex shrink-0 flex-col gap-0">
      <div ref={underlayRef} aria-hidden="true" className={navUnderlay} />
      <div ref={hoverUnderlayRef} aria-hidden="true" className={navUnderlay} />
      {children}
    </div>
  )
}

/**
 * The sidebar: the logo and the global buttons, the workspaces, and the user and connections. The
 * user's own button opens a menu of the settings and signing out.
 */
export const Sidebar = ({
  user,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  onGoHome,
  logoUrl,
  announcement,
  notice,
  connections,
  library,
  workspacesPage,
  automationsPage,
  connectionsPage,
  settingsPage,
  onSignOut,
  onSearch,
  collapsed = false,
  layout = 'rows',
}: SidebarProps) => {
  const narrow = useNarrowScreen()
  const rows = layout === 'rows'
  const home = (
    <Button
      icon={logoUrl ? <img src={logoUrl} alt="" className="size-[1.5em] object-contain" /> : <LogoIcon />}
      aria-label="Home"
      onClick={onGoHome}
      className="[&>svg]:size-[1.5em]"
    />
  )
  // In from the edge as a workspace's title is, and quiet, as it is said to everyone all along.
  const said = announcement && (
    <div role="note" aria-label="Announcement" className="shrink-0 px-2 text-sm leading-snug text-kumo-subtle wrap-break-word [&_a]:font-medium [&_a]:text-kumo-default">
      <Markdown>{announcement}</Markdown>
    </div>
  )
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
        aria-label={waitingLabel('Library', waiting) ?? 'Library'}
        aria-current={library?.current ? 'page' : undefined}
        onClick={library?.onOpen}
        className="aria-[current=page]:bg-kumo-tint"
      />
      {waiting > 0 && <WaitingCount count={waiting} className="pointer-events-none absolute -top-1 -right-1 ring-2 ring-kumo-canvas" />}
    </span>
  )
  const automationsButton = (
    <Button
      icon={LightningIcon}
      aria-label="Automations"
      aria-current={automationsPage?.current ? 'page' : undefined}
      onClick={automationsPage?.onOpen}
      className="aria-[current=page]:bg-kumo-tint"
    />
  )
  const search = <Button icon={MagnifyingGlassIcon} aria-label="Search" onClick={onSearch} />
  const account = (
    <DropdownMenu
      icon={<Avatar name={user.name} src={user.avatarUrl} />}
      aria-label={`Account, ${user.name}`}
      keepTrigger
      side="top"
      align="start"
      triggerClassName={settingsPage?.current ? 'bg-kumo-tint' : undefined}
      // About the sidebar's own width (248px, from 208), rather than as wide as two short words.
      popupClassName="w-56 max-w-(--available-width)"
    >
      <DropdownMenu.Item icon={GearIcon} onSelect={settingsPage?.onOpen}>Settings</DropdownMenu.Item>
      {onSignOut && <DropdownMenu.Item icon={SignOutIcon} onSelect={onSignOut}>Sign out</DropdownMenu.Item>}
    </DropdownMenu>
  )
  const connect = (
    <ConnectButton onConnect={connectionsPage?.onOpen} current={connectionsPage?.current}>
      {connections && connections.length > 0
        ? connections.map(({ name, logoUrl, wide }) => <ServiceLogo key={name} name={name} src={logoUrl} bare={wide ? 'wide' : true} />)
        : undefined}
    </ConnectButton>
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
          {automationsButton}
          <Button
            icon={PuzzlePieceIcon}
            aria-label="Connections"
            aria-current={connectionsPage?.current ? 'page' : undefined}
            onClick={connectionsPage?.onOpen}
            className="aria-[current=page]:bg-kumo-tint"
          />
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
            <Button icon={MagnifyingGlassIcon} aria-label="Search" onClick={onSearch}>
              <kbd className="font-sans font-normal text-kumo-subtle">{searchKeys()}</kbd>
            </Button>
          )}
        </header>
        {said}
        {nav}
        <footer className="mt-0.5">
          <NavRows>
            <NavRow icon={<FolderIcon />} label="Workspaces" current={workspacesPage?.current} onClick={workspacesPage?.onOpen} />
            <NavRow
              icon={<CirclesFourIcon />}
              label="Library"
              aria-label={waitingLabel('Library', waiting)}
              current={library?.current}
              onClick={library?.onOpen}
              waiting={waiting}
            />
            <NavRow icon={<LightningIcon />} label="Automations" current={automationsPage?.current} onClick={automationsPage?.onOpen} />
          </NavRows>
          {/* The account is in from the edge as a row's circle is (`p-2`), so that it lines up with them; the connect button ends where the search button does, over it. */}
          <div className="flex items-center justify-between pt-2 pl-2">
            {account}
            {connect}
          </div>
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
            {automationsButton}
            {workspacesButton}
          </div>
          <RailDivider />
        </header>
        {nav}
        <footer className="mt-3 flex flex-col items-center gap-1">
          <ConnectButton onConnect={connectionsPage?.onOpen} current={connectionsPage?.current} />
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
        {automationsButton}
        {search}
      </header>
      {said}
      {nav}
      <footer className="flex items-center justify-between">
        {account}
        {connect}
      </footer>
    </div>
  )
}
