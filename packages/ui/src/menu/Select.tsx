import type { ComponentProps, ReactNode } from 'react'
import { ArrowDown01Icon } from '../icons/icons'
import { DropdownMenu } from './DropdownMenu'
import { OptionPicker } from './OptionPicker'

export type SelectOption<Value extends string> = {
  id: Value
  label: string
  /** What it is drawn with before its label, where the options have a field to find one by. */
  icon?: ReactNode
}

export type SelectProps<Value extends string> = {
  /** The id of the one chosen. */
  value: Value
  onValueChange: (value: Value) => void
  options: SelectOption<Value>[]
  /** What it is a choice of, said with the one chosen as the button's name: "Theme". */
  'aria-label': string
  /** What the button says while the value is none of the options. */
  placeholder?: string
  /** A field to find one by, for more options than are easily read through. */
  searchable?: boolean
  /**
   * Quiet and small, for a line of figures rather than a form: no surface until pointed at, and
   * what it says is `shown` where that is not the label of the option chosen.
   */
  compact?: { shown?: string; align?: 'start' | 'end'; medium?: boolean }
  /**
   * The value is one of the user's own, typed where the button would say which, while the one
   * chosen is the option that stands for that ("Custom"). The options are still under the chevron.
   */
  typed?: SelectTyped
}

/** What is typed in a `Select`, and what its field is given: a name of its own, as the button's says which option is chosen. */
export type SelectTyped = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'className' | 'type' | 'aria-label'> & {
  'aria-label': string
  value: string
  onValueChange: (value: string) => void
  /** What is in it cannot be kept as it is. */
  invalid?: boolean
}

// A field's corners, the room at its ends and the weight of what it says (`TextField`), not a
// button's: what is chosen from is filled in, as what is typed is, and only what is pressed to do
// something is fully round.
// The menu grows out of the same corners, which it reads from the button.
const FIELD_SHAPE = 'rounded-xl px-3 font-normal'
const COMPACT_SHAPE = 'h-7 gap-1 rounded-full px-2.5 text-xs font-normal text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default max-sm:h-10 max-sm:text-sm'

/**
 * One of a few things, chosen from a menu: a field that says which, as wide as what it says and
 * no wider than the room it has, and opens in place to them all, the chosen one ticked. Choosing
 * closes it. With `typed`, what it says is a field to write a value of the user's own in.
 */
export const Select = <Value extends string>({ value, onValueChange, options, 'aria-label': label, placeholder = 'Choose…', searchable = false, compact, typed }: SelectProps<Value>) => {
  const chosen = options.find(({ id }) => id === value)
  const said = compact?.shown ?? chosen?.label ?? placeholder

  const menu = (
    <DropdownMenu
      // Cut off where there is not room for all of a long one. Typed in, it says nothing: the
      // room is the field's, which is over it.
      label={(
        <>
          {typed ? <span className="w-24" /> : <span className="min-w-0 truncate">{said}</span>}
          {/* Its own chevron rather than the menu's (`caret`): quieter than what it says, as a field's is. */}
          <span className="-me-0.5 flex text-kumo-subtle"><ArrowDown01Icon aria-hidden="true" weight="bold" className="size-3" /></span>
        </>
      )}
      aria-label={`${label}: ${said}`}
      triggerClassName={`max-w-full min-w-0 shrink ${compact ? `${COMPACT_SHAPE}${compact.medium ? ' font-medium' : ''}` : FIELD_SHAPE}`}
      triggerVariant={compact ? 'ghost' : undefined}
      picker={searchable}
      align={compact?.align ?? 'end'}
      inPlace
    >
      {(close) =>
        searchable ? (
          <OptionPicker
            single
            aria-label={label}
            options={options}
            value={value}
            onValueChange={(id) => {
              // The picker knows its options only as strings.
              onValueChange(id as Value)
              close()
            }}
          />
        ) : (
          <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange} aria-label={label}>
            {options.map(({ id, label: name }) => <DropdownMenu.RadioItem key={id} value={id}>{name}</DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
        )}
    </DropdownMenu>
  )
  if (!typed) return menu

  const { value: text, onValueChange: onTyped, invalid, ...field } = typed
  return (
    // The button is still the surface and the way to the options, at its chevron. The field is
    // over the rest of it rather than in it, as a button can hold nothing that is typed in, and
    // the ring that says where the keyboard is goes round them both.
    <span className="relative inline-flex max-w-full min-w-0 rounded-xl has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-kumo-focus has-[input[aria-invalid]]:ring-1 has-[input[aria-invalid]]:ring-kumo-danger">
      {menu}
      <input
        {...field}
        type="text"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(event) => onTyped(event.target.value)}
        className="absolute inset-y-0 start-0 end-8 min-w-0 appearance-none rounded-s-xl border-0 bg-transparent ps-3 text-(length:--control-text) text-kumo-default outline-none placeholder:text-kumo-subtle"
      />
    </span>
  )
}
