import { DropdownMenu } from '../menu/DropdownMenu'

/** Something someone could be given, as a menu offers it. */
export type AccessChoice<Value extends string> = {
  value: Value
  /** What it is, as the trigger reads once chosen: "Can join". */
  label: string
  /** What it lets them do, under the label. */
  hint: string
}

export type AccessMenuProps<Value extends string> = {
  /** What they have now, as the trigger reads: "Can use". */
  label: string
  /** Whose access it is, for the trigger's name: "Ada Lovelace", "anyone with the link". */
  of: string
  /** What they could have instead, with the one they have ticked. */
  choices?: { options: readonly AccessChoice<Value>[]; value: Value; onChange: (value: Value) => void }
  /** Takes their access away, after the choices: "Remove from workspace". */
  remove?: { label: string; onRemove: () => void }
  disabled?: boolean
}

/**
 * Someone's access, as a quiet button with a chevron that opens in place to what else they could
 * have, each with what it lets them do, and the way to take it away, last and in red.
 */
export const AccessMenu = <Value extends string>({ label, of, choices, remove, disabled }: AccessMenuProps<Value>) => (
  <DropdownMenu
    label={label}
    caret
    aria-label={`Access for ${of}: ${label}`}
    triggerVariant="ghost"
    // Quieter than a name, as the row's role is when it cannot be changed. Not to be opened while
    // a change to it is under way.
    triggerClassName={disabled ? 'pointer-events-none px-3 font-normal text-kumo-subtle opacity-50' : 'px-3 font-normal text-kumo-subtle'}
    align="end"
    inPlace
  >
    {choices && (
      <DropdownMenu.RadioGroup value={choices.value} onValueChange={choices.onChange} aria-label={`Access for ${of}`}>
        {choices.options.map(({ value, label: name, hint }) => (
          <DropdownMenu.RadioItem key={value} value={value}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{name}</span>
              <span className="text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{hint}</span>
            </span>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
    )}
    {choices && remove && <DropdownMenu.Separator />}
    {remove && <DropdownMenu.Item danger onSelect={remove.onRemove}>{remove.label}</DropdownMenu.Item>}
  </DropdownMenu>
)
