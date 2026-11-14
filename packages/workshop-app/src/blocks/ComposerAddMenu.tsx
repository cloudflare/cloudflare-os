import type { RefObject } from 'react'
import { MagnifyingGlassIcon, PaperclipIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import { commandGlyph, type ComposerCommand } from './ComposerCommandPicker'

export type ComposerAddActions = {
  onUpload?: () => void
  onAddConnection?: () => void
}

type ComposerAddMenuProps = ComposerAddActions & {
  anchorRef: RefObject<HTMLElement | null>
  /** Keep the popup's anchored corner at the button's original position. */
  inPlace?: boolean
  /**
   * The skills and commands the draft can go with. A few are listed by name; when there are more,
   * the last row offers them all, as typing a slash does.
   */
  commands?: {
    items: readonly ComposerCommand[]
    onChoose: (command: ComposerCommand) => void
    onBrowse: () => void
  }
}

/** How many commands the menu names before it offers the rest by a slash. */
const LISTED = 5

/** The composer's action picker. Its callers supply capabilities; absent actions stay disabled. */
export const ComposerAddMenu = ({ anchorRef, inPlace, onUpload, onAddConnection, commands }: ComposerAddMenuProps) => {
  const items = commands?.items ?? []
  // A command of the app's own, such as Compact, is not a skill: it comes after them.
  const listed = [...items.filter(({ kind }) => kind === 'skill'), ...items.filter(({ kind }) => kind !== 'skill')]
  const more = listed.length > LISTED
  return (
    <DropdownMenu
      icon={<PlusIcon weight="bold" />}
      aria-label="Add to conversation"
      triggerClassName="size-[30px] text-kumo-subtle not-data-disabled:hover:text-kumo-default [&>svg]:size-3.5"
      triggerVariant="ghost"
      anchorRef={anchorRef}
      side="top"
      inPlace={inPlace}
    >
      <DropdownMenu.Item icon={PaperclipIcon} onSelect={onUpload} disabled={!onUpload}>
        <span>Upload files or photos</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item icon={PlugIcon} onSelect={onAddConnection} disabled={!onAddConnection}>
        <span>Add a new connection</span>
      </DropdownMenu.Item>
      {commands && listed.length > 0 && (
        <>
          <DropdownMenu.Separator />
          {listed.slice(0, more ? LISTED - 1 : LISTED).map((command) => (
            <DropdownMenu.Item
              key={command.key}
              icon={commandGlyph(command)}
              label={command.title}
              onSelect={() => commands.onChoose(command)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{command.title}</span>
                <span className="block truncate text-sm text-kumo-subtle">{command.description}</span>
              </span>
            </DropdownMenu.Item>
          ))}
          {more && (
            <DropdownMenu.Item icon={MagnifyingGlassIcon} onSelect={commands.onBrowse}>
              <span className="min-w-0 flex-1">All skills</span>
              <span className="text-sm text-kumo-subtle">{listed.length}</span>
            </DropdownMenu.Item>
          )}
        </>
      )}
    </DropdownMenu>
  )
}
