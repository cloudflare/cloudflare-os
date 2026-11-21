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
  /** What the options are, as the name of the field that finds one: "Members". */
  'aria-label': string
} & (
  | {
      single?: false
      /** The ids of the options that are ticked. */
      value: string[]
      onValueChange: (ids: string[]) => void
    }
  | {
      /** One of the options is the one chosen, rather than any number of them ticked. */
      single: true
      /** The id of the option that is chosen. */
      value: string
      /** Told of every choice, the one already chosen included, as that is still an answer. */
      onValueChange: (id: string) => void
    }
)

// Kept from a menu it may be in, which would take letters for its own items, the arrows for moving
// among them, and Home and End. What closes the menu still reaches it: Escape, Tab, and the arrow
// back out of it once there is no text for it to move through.
const keepFromMenu = (event: KeyboardEvent<HTMLDivElement>) => {
  const field = event.target instanceof HTMLInputElement ? event.target : undefined
  const leaves = event.key === 'Escape' || event.key === 'Tab' || (event.key === 'ArrowLeft' && field?.value === '')
  if (!leaves) event.stopPropagation()
}

/**
 * Options to tick, any number of them, or to choose one of (`single`), under a field that narrows
 * them to those with what is typed in their label. For more options than are easily read through,
 * as in a menu of people. The field has the focus as soon as it is there, and the arrow keys move
 * through the options from it, so typing and choosing need no pointer.
 */
export const OptionPicker = ({ options, 'aria-label': label, ...choice }: OptionPickerProps) => {
  const fieldRef = useRef<HTMLInputElement>(null)
  useEffect(() => fieldRef.current?.focus({ preventScroll: true }), [])
  const shared = {
    inline: true,
    open: true,
    autoHighlight: true,
    items: options,
    itemToStringLabel: (option: PickerOption) => option.label,
    isItemEqualToValue: (a: PickerOption, b: PickerOption) => a.id === b.id,
  }
  const content = (
    <>
      <Combobox.Input
        ref={fieldRef}
        aria-label={label}
        placeholder="Filter…"
        autoComplete="off"
        spellCheck={false}
        // A menu's line, which is 16px on a narrow screen, where iOS would zoom the page in on a
        // field with smaller text.
        className="mx-1.5 mt-1.5 shrink-0 appearance-none border-0 border-b border-kumo-line bg-transparent px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none placeholder:text-kumo-subtle"
      />
      {/* In line with the options' text, which the list's own padding moves in. */}
      <Combobox.Empty className="px-[calc(var(--menu-pad-x)+0.375rem)] py-4 text-(length:--menu-text) leading-(--menu-line) text-kumo-subtle empty:hidden">Nothing matches.</Combobox.Empty>
      <Combobox.List className="min-h-0 overflow-y-auto overscroll-contain p-1.5 outline-none empty:hidden">
        {(option: PickerOption) => (
          <Combobox.Item
            key={option.id}
            value={option}
            // As a menu's items are, which this is in.
            className="flex cursor-pointer items-center gap-3 rounded-2xl px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none data-highlighted:bg-kumo-tint"
          >
            {option.icon !== undefined && <span className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle">{option.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <span className="grid size-(--menu-icon) shrink-0 place-items-center">
              <Combobox.ItemIndicator><CheckIcon aria-hidden="true" weight="bold" className="size-(--menu-icon)" /></Combobox.ItemIndicator>
            </span>
          </Combobox.Item>
        )}
      </Combobox.List>
    </>
  )

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={keepFromMenu}>
      {choice.single ? (
        <Combobox.Root
          {...shared}
          value={options.find(({ id }) => id === choice.value) ?? null}
          onValueChange={(chosen: PickerOption | null) => {
            if (chosen) choice.onValueChange(chosen.id)
          }}
        >
          {content}
        </Combobox.Root>
      ) : (
        <Combobox.Root
          {...shared}
          multiple
          value={options.filter(({ id }) => choice.value.includes(id))}
          onValueChange={(ticked: PickerOption[]) => choice.onValueChange(ticked.map(({ id }) => id))}
        >
          {content}
        </Combobox.Root>
      )}
    </div>
  )
}
