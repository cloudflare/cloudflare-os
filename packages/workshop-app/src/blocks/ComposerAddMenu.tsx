import type { RefObject } from 'react'
import { CaretLeftIcon, CaretRightIcon, CheckIcon, CubeIcon, MagnifyingGlassIcon, PaperclipIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'
import { useMenuPages } from '@/components/useMenuPages'
import { commandGlyph, type ComposerCommand } from './ComposerCommandPicker'

/** A model the draft can go to, as the menu lists it. */
export type ComposerModel = { id: string; name: string; description?: string }

export type ComposerAddActions = {
  onUpload?: () => void
  onAddConnection?: () => void
  /**
   * The model the draft goes to, and the others it could. The composer has no room for a picker,
   * so it is a row of this menu, which shows the list in its place.
   */
  model?: {
    models: readonly ComposerModel[]
    current: string
    onChoose: (id: string) => void
  }
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
export const ComposerAddMenu = ({ anchorRef, inPlace, onUpload, onAddConnection, model, commands }: ComposerAddMenuProps) => {
  const items = commands?.items ?? []
  // A command of the app's own, such as Compact, is not a skill: it comes after them.
  const listed = [...items.filter(({ kind }) => kind === 'skill'), ...items.filter(({ kind }) => kind !== 'skill')]
  const more = listed.length > LISTED
  // Which list the menu shows: its own rows, or the models in their place.
  const { page, show, rows, onOpenChangeComplete } = useMenuPages<'main' | 'models'>('main')
  const current = model?.models.find(({ id }) => id === model.current)

  return (
    <DropdownMenu
      icon={<PlusIcon weight="bold" />}
      aria-label="Add to conversation"
      triggerClassName="size-(--composer-button) text-kumo-subtle not-data-disabled:hover:text-kumo-default [&>svg]:size-[calc(var(--composer-button)*0.47)]"
      triggerVariant="ghost"
      anchorRef={anchorRef}
      side="top"
      inPlace={inPlace}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <div ref={rows}>
        {page === 'models' && model ? (
          <>
            <DropdownMenu.Item icon={CaretLeftIcon} onSelect={() => show('main')} keepsOpen label="Back">
              <span className="text-kumo-subtle">Model</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            {model.models.map((each) => (
              <DropdownMenu.Item key={each.id} label={each.name} onSelect={() => model.onChoose(each.id)} current={each.id === model.current}>
                {/* Ticked in the icons' column, so the names line up under the rows above. */}
                {each.id === model.current
                  ? <CheckIcon aria-hidden="true" weight="bold" className="size-4 shrink-0" />
                  : <span aria-hidden="true" className="size-4 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{each.name}</span>
                  {each.description && <span className="block truncate text-sm text-kumo-subtle">{each.description}</span>}
                </span>
              </DropdownMenu.Item>
            ))}
          </>
        ) : (
          <>
            <DropdownMenu.Item icon={PaperclipIcon} onSelect={onUpload} disabled={!onUpload}>
              <span>Upload files or photos</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item icon={PlugIcon} onSelect={onAddConnection} disabled={!onAddConnection}>
              <span>Add a new connection</span>
            </DropdownMenu.Item>
            {model && (
              <DropdownMenu.Item icon={CubeIcon} onSelect={() => show('models')} keepsOpen label="Model" row="models">
                <span className="flex-1">Model</span>
                <span className="max-w-40 truncate text-sm text-kumo-subtle">{current?.name}</span>
                <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
              </DropdownMenu.Item>
            )}
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
          </>
        )}
      </div>
    </DropdownMenu>
  )
}
