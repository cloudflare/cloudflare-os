import { CaretDownIcon, CheckIcon, PlusIcon } from '@phosphor-icons/react'
import { ChatMark } from '@/components/ChatMark'
import { DropdownMenu } from '@/components/DropdownMenu'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

export type WorkspacePickerProps = {
  /** The named workspaces a chat can be started in. */
  workspaces: readonly { id: string; title: string; label: string }[]
  /** The one chosen; none, for a chat on its own. */
  value?: string
  onChange: (id: string | undefined) => void
  /** Goes to make a new workspace. */
  onCreate: () => void
}

/**
 * Where a new chat goes, under the composer that starts it: on its own ("No workspace"), or in one
 * of the user's named workspaces, with the way to make another. Quiet until it is pointed at, as
 * most chats start on their own.
 */
export const WorkspacePicker = ({ workspaces, value, onChange, onCreate }: WorkspacePickerProps) => {
  const chosen = value === undefined ? undefined : workspaces.find(({ id }) => id === value)
  const tick = (on: boolean) => (on
    ? <CheckIcon aria-label="Chosen" weight="bold" className="size-3.5 shrink-0" />
    : <span aria-hidden="true" className="size-3.5 shrink-0" />)
  return (
    <DropdownMenu
      label={(
        <span className="flex min-w-0 items-center gap-2">
          {chosen ? <WorkspaceIcon label={chosen.label} small /> : null}
          <span className="min-w-0 truncate">{chosen?.title ?? 'No workspace'}</span>
          <CaretDownIcon aria-hidden="true" weight="bold" className="size-3 shrink-0" />
        </span>
      )}
      aria-label={`Start it in: ${chosen?.title ?? 'no workspace'}`}
      triggerVariant="ghost"
      triggerClassName="h-8 max-w-64 px-3 text-sm text-kumo-subtle not-data-disabled:hover:text-kumo-default"
      align="center"
    >
      <DropdownMenu.Item label="No workspace" onSelect={() => onChange(undefined)}>
        <ChatMark small />
        <span className="min-w-0 flex-1">
          <span className="block">No workspace</span>
          <span className="block text-sm text-kumo-subtle">A chat on its own</span>
        </span>
        {tick(chosen === undefined)}
      </DropdownMenu.Item>
      {workspaces.length > 0 && <DropdownMenu.Separator />}
      {workspaces.map((workspace) => (
        <DropdownMenu.Item key={workspace.id} label={workspace.title} onSelect={() => onChange(workspace.id)}>
          <WorkspaceIcon label={workspace.label} small />
          <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
          {tick(workspace.id === chosen?.id)}
        </DropdownMenu.Item>
      ))}
      <DropdownMenu.Separator />
      <DropdownMenu.Item icon={PlusIcon} onSelect={onCreate}>
        <span className="text-kumo-subtle">New workspace</span>
      </DropdownMenu.Item>
    </DropdownMenu>
  )
}
