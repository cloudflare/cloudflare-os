import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'

/** One of the choices, as the menu lists it. */
export type MenuChoice = { id: string; name: string; description?: string }

export type MenuChooserProps = {
  choices: readonly MenuChoice[]
  /** The one chosen, or null for none, which only `none` offers; undefined while none is. */
  value?: string | null
  onChoose: (id: string | null) => void
  /** What the choice is, for its accessible name: "Writer", "Default model". */
  label: string
  /** Offers none as a choice, under the rest, named so: "No agent". */
  none?: string
  /** What it says while nothing is chosen. */
  placeholder?: string
}

const tick = (on: boolean) => (on
  ? <CheckIcon aria-label="Chosen" weight="bold" className="size-3.5 shrink-0" />
  : <span aria-hidden="true" className="size-3.5 shrink-0" />)

/**
 * One of a few choices, such as a model, as a button that names the one chosen and opens a menu of
 * them all, each with a line on what it is where it says, and the chosen one ticked.
 */
export const MenuChooser = ({ choices, value, onChoose, label, none, placeholder = 'Choose' }: MenuChooserProps) => {
  const chosen = value === null ? none : choices.find(({ id }) => id === value)?.name
  return (
    <DropdownMenu
      label={(
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{chosen ?? placeholder}</span>
          <CaretDownIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
        </span>
      )}
      aria-label={`${label}: ${chosen ?? 'none chosen'}`}
      triggerClassName="h-8 max-w-48 px-3 text-sm"
      align="end"
    >
      {choices.map((choice) => (
        <DropdownMenu.Item key={choice.id} label={choice.name} onSelect={() => onChoose(choice.id)}>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{choice.name}</span>
            {choice.description && <span className="block truncate text-sm text-kumo-subtle">{choice.description}</span>}
          </span>
          {tick(choice.id === value)}
        </DropdownMenu.Item>
      ))}
      {none && (
        <>
          {choices.length > 0 && <DropdownMenu.Separator />}
          <DropdownMenu.Item label={none} onSelect={() => onChoose(null)}>
            <span className="min-w-0 flex-1 text-kumo-subtle">{none}</span>
            {tick(value === null)}
          </DropdownMenu.Item>
        </>
      )}
    </DropdownMenu>
  )
}
