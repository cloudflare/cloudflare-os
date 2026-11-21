import { PlusIcon } from '@phosphor-icons/react'
import { DropdownMenu, OptionPicker } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'

export type WorkspacePickerProps = {
  /** The workspaces there are to choose from, in the order they are offered. */
  workspaces: {
    id: string
    title: string
    /** Two letters shown on the icon. */
    label: string
    /** How its icon is drawn, when not as any workspace's is. */
    look?: WorkspaceLook
  }[]
  /** The id of the one chosen. With none, it is a new workspace, yet to be made. */
  value: string | undefined
  onValueChange: (id: string | undefined) => void
}

// The option that is no workspace: an id none has, theirs being URL-safe base64.
const NEW = ':new'
const NEW_TITLE = 'New workspace'

/**
 * Where something is to be: in a new workspace, or in one of those there are. A button that says
 * which, and opens to them all under a field to find one by.
 */
export const WorkspacePicker = ({ workspaces, value, onValueChange }: WorkspacePickerProps) => {
  const chosen = workspaces.find(({ id }) => id === value)
  const title = chosen?.title ?? NEW_TITLE

  return (
    <DropdownMenu
      // One that was chosen is shown as it is drawn everywhere else. In a span, so that it keeps its
      // own size rather than taking the Button's size for an icon.
      icon={chosen && <span className="flex"><WorkspaceIcon label={chosen.label} {...chosen.look} small /></span>}
      // Cut off where there is not room for all of a long title.
      label={<span className="min-w-0 truncate">{title}</span>}
      // Said with what it is a choice of, or "New workspace" reads as a button that makes one.
      aria-label={`Workspace: ${title}`}
      // Quiet under the composer until it is pointed at.
      triggerClassName="max-w-full min-w-0 shrink text-kumo-subtle hover:text-kumo-default"
      triggerVariant="ghost"
      caret
      picker
      align="center"
      inPlace
    >
      {(close) => (
        <OptionPicker
          single
          aria-label="Workspace"
          options={[
            { id: NEW, label: NEW_TITLE, icon: <PlusIcon aria-hidden="true" className="size-4" /> },
            ...workspaces.map((workspace) => ({ id: workspace.id, label: workspace.title, icon: <WorkspaceIcon label={workspace.label} {...workspace.look} small /> })),
          ]}
          value={chosen?.id ?? NEW}
          onValueChange={(id) => {
            onValueChange(id === NEW ? undefined : id)
            close()
          }}
        />
      )}
    </DropdownMenu>
  )
}
