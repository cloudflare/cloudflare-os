import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Combobox } from '@cloudflare/kumo/primitives/combobox'
import { CheckIcon } from '@phosphor-icons/react'

export type PickerOption = {
  id: string
  label: string
  /** What it is drawn with before its label, such as a person's picture. */
  icon?: ReactNode
}

export type OptionPickerProps = {
  options: PickerOption[]
  /** The ids of the options that are ticked. */
  value: string[]
  onValueChange: (ids: string[]) => void
  /** What the options are, as the name of the field that finds one: "Members". */
  'aria-label': string
}

// Kept from a menu it may be in, which would take letters for its own items, the arrows for moving
// among them, and Home and End. What closes the menu still reaches it: Escape, Tab, and the arrow
// back out of it once there is no text for it to move through.
const keepFromMenu = (event: KeyboardEvent<HTMLDivElement>) => {
  const field = event.target instanceof HTMLInputElement ? event.target : undefined
  const leaves = event.key === 'Escape' || event.key === 'Tab' || (event.key === 'ArrowLeft' && field?.value === '')
  if (!leaves) event.stopPropagation()
}

/**
 * Options to tick, any number of them, under a field that narrows them to those with what is typed
 * in their label. For more options than are easily read through, as in a menu of people. The field
 * has the focus as soon as it is there, and the arrow keys move through the options from it, so
 * typing and choosing need no pointer.
 */
export const OptionPicker = ({ options, value, onValueChange, 'aria-label': label }: OptionPickerProps) => {
  const fieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => fieldRef.current?.focus({ preventScroll: true }), [])

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={keepFromMenu}>
      <Combobox.Root
        inline
        open
        multiple
        autoHighlight
        items={options}
        value={options.filter(({ id }) => value.includes(id))}
        onValueChange={(ticked: PickerOption[]) => onValueChange(ticked.map(({ id }) => id))}
        itemToStringLabel={(option: PickerOption) => option.label}
        isItemEqualToValue={(a: PickerOption, b: PickerOption) => a.id === b.id}
      >
        <Combobox.Input
          ref={fieldRef}
          aria-label={label}
          placeholder="Filter…"
          autoComplete="off"
          spellCheck={false}
          // 16px at least on a narrow screen, or iOS zooms the page in on it.
          className="mx-1.5 mt-1.5 shrink-0 appearance-none border-0 border-b border-kumo-line bg-transparent px-3 py-2.5 text-base/5 text-kumo-default outline-none placeholder:text-kumo-subtle max-md:text-[16px]/5"
        />
        <Combobox.Empty className="px-4.5 py-4 text-base/5 text-kumo-subtle empty:hidden">Nothing matches.</Combobox.Empty>
        <Combobox.List className="min-h-0 overflow-y-auto overscroll-contain p-1.5 outline-none empty:hidden">
          {(option: PickerOption) => (
            <Combobox.Item
              key={option.id}
              value={option}
              className="flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-base/5 text-kumo-default outline-none data-highlighted:bg-kumo-tint"
            >
              {option.icon !== undefined && <span className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle">{option.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span className="grid size-4 shrink-0 place-items-center">
                <Combobox.ItemIndicator><CheckIcon aria-hidden="true" weight="bold" className="size-4" /></Combobox.ItemIndicator>
              </span>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Root>
    </div>
  )
}
