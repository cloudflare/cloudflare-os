import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react'
import { DropdownMenu } from '@/components/DropdownMenu'

export type AccessChoice<Value extends string> = {
  value: Value
  label: string
  /** What it lets them do, under the label. */
  hint: string
}

export type AccessMenuProps<Value extends string> = {
  /** What they have now, as the trigger reads: "Can use". */
  label: string
  /** Whose access it is, for the trigger's name: "Ada Lovelace", "people you add". */
  of: string
  /** What they could have instead, with the one they have ticked. */
  choices?: { options: readonly AccessChoice<Value>[]; value: Value; onChange: (value: Value) => void }
  /** Takes their access away, under the choices: "Remove access". */
  remove?: { label: string; onRemove: () => void }
  disabled?: boolean
}

/**
 * Someone's access, as a quiet button with a caret that opens to what else they could have and
 * the way to take it away. The menu grows out of the button, as every menu here does.
 */
export const AccessMenu = <Value extends string>({ label, of, choices, remove, disabled }: AccessMenuProps<Value>) => (
  <DropdownMenu
    aria-label={`Access for ${of}: ${label}`}
    triggerVariant="ghost"
    align="end"
    triggerClassName="px-3 text-kumo-default data-disabled:opacity-50"
    label={(
      <span className="flex items-center gap-1.5">
        {label}
        <CaretDownIcon aria-hidden="true" weight="bold" className="size-3 text-kumo-subtle" />
      </span>
    )}
    disabled={disabled}
  >
    {choices?.options.map((option) => (
      <DropdownMenu.Item
        key={option.value}
        label={option.label}
        onSelect={() => { if (option.value !== choices.value) choices.onChange(option.value) }}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span>{option.label}</span>
          <span className="text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{option.hint}</span>
        </span>
        {option.value === choices.value
          ? <CheckIcon aria-label="(chosen)" weight="bold" className="size-3.5 shrink-0" />
          : <span aria-hidden="true" className="size-3.5 shrink-0" />}
      </DropdownMenu.Item>
    ))}
    {choices && remove && <DropdownMenu.Separator />}
    {remove && <DropdownMenu.Item danger onSelect={remove.onRemove}>{remove.label}</DropdownMenu.Item>}
  </DropdownMenu>
)
