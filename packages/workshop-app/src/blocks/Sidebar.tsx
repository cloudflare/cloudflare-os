import type { ReactNode } from 'react'
import { CirclesFourIcon, FolderIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { LogoIcon } from '@/components/LogoIcon'
import { WorkspaceNav, type SidebarWorkspace } from './WorkspaceNav'

export type { SidebarWorkspace }

export type SidebarProps = {
  user: { name: string; avatarUrl?: string }
  workspaces: SidebarWorkspace[]
  selectedWorkspaceId?: string
  onSelectWorkspace: (id: string) => void
  /** Shown in place of the list when there is nothing to list, e.g. "No workspaces yet." */
  notice?: string
  /** Logos of the connected apps, shown in the connect button. */
  connections?: ReactNode
  /** The library, which opens beside the page, and whether it is showing. */
  library?: { shown: boolean; onToggle: () => void }
  /** Drawn as a rail one button wide: the same buttons in a column, and each workspace's icon. */
  collapsed?: boolean
}

const RailDivider = () => <span aria-hidden="true" className="my-4 h-px w-4 shrink-0 bg-kumo-line" />

/** The sidebar: global buttons on top, the workspaces, then the user and connections. */
export const Sidebar = ({
  user,
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
  notice,
  connections,
  library,
  collapsed = false,
}: SidebarProps) => {
  const home = <Button icon={<LogoIcon />} aria-label="Home" className="[&>svg]:size-[1.5em]" />
  const workspacesButton = <Button icon={FolderIcon} aria-label="Workspaces" />
  const libraryButton = (
    <Button
      icon={CirclesFourIcon}
      aria-label="Library"
      aria-pressed={library?.shown}
      onClick={library?.onToggle}
      className="aria-pressed:bg-kumo-tint"
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
    />
  )

  if (collapsed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center p-0.5">
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-0.5">
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
