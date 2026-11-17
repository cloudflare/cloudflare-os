import type { ElementType, KeyboardEvent, ReactElement, ReactNode } from 'react'
import { Menu } from '@cloudflare/kumo/primitives/menu'
import { cn } from '@cloudflare/kumo/utils'
import { Button, type ButtonProps } from './Button'
import { DropdownMenu } from './DropdownMenu'

type TriggerContent =
  | { label: ReactNode; icon?: ElementType | ReactElement; 'aria-label'?: string }
  // Without visible text the trigger needs an accessible name.
  | { label?: undefined; icon: ElementType | ReactElement; 'aria-label': string }

export type ConfirmMenuProps = TriggerContent & {
  /** What is asked, such as "Disconnect Google?". */
  title: string
  /** What doing it will do. */
  description?: string
  /** The button that does it, which says what it does: "Disconnect". */
  confirmLabel: string
  onConfirm: () => void
  /** The trigger Button's variant, which the question's surface grows out of. */
  triggerVariant?: ButtonProps['variant']
  /** Sizes and styles the trigger Button. */
  triggerClassName?: string
  /** Which way the question grows from the trigger, and which of its corners it keeps. */
  side?: 'top' | 'bottom'
  align?: 'start' | 'end'
  disabled?: boolean
}

/**
 * A menu's items take no Tab, which would close it, so the question could not be answered from
 * the keyboard other than by the arrow keys. Tab and Shift+Tab go between its two buttons instead,
 * round and round, as in a dialog, and so do the left and right arrows, in the order they are seen
 * in. Focusing an item is what makes it the menu's highlighted one.
 */
const moveBetween = (event: KeyboardEvent<HTMLElement>, reversed: boolean) => {
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
  if (event.key !== 'Tab' && !horizontal) return
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const at = items.indexOf(event.target as HTMLElement)
  if (at === -1) return
  event.preventDefault()
  event.stopPropagation()
  const forward = horizontal ? (event.key === 'ArrowRight') !== reversed : !event.shiftKey
  items[(at + (forward ? 1 : items.length - 1)) % items.length].focus()
}

/**
 * A button for what cannot be taken back, which asks first: the question grows out of the
 * button in place, as a menu does (`DropdownMenu`), keeping the corner of it that `side` and
 * `align` say, with what it will do, and Cancel beside the button that does it, at that side. Cancel, Escape or a click
 * anywhere else puts the question away and does nothing.
 */
export const ConfirmMenu = ({ title, description, confirmLabel, onConfirm, triggerVariant = 'danger', triggerClassName, side = 'top', align = 'end', disabled = false, ...trigger }: ConfirmMenuProps) => (
  <DropdownMenu
    {...trigger}
    triggerVariant={triggerVariant}
    // Not to be opened while what it would do is under way, or would not be let.
    triggerClassName={cn(triggerClassName, disabled && 'pointer-events-none opacity-50')}
    side={side}
    align={align}
    inPlace
    raised
  >
    <div className="flex w-80 max-w-full flex-col p-3 pt-2.5">
      <p className="px-1.5 font-medium text-kumo-default">{title}</p>
      {description && <p className="mt-1 px-1.5 text-sm leading-normal text-kumo-subtle">{description}</p>}
      {/* At the side the question keeps the trigger's corner at, with Cancel nearest it, where the
          trigger was: a second click where the first was asks nothing. Cancel stays first all the
          same, for the keyboard, which starts at the first. */}
      <div className={cn('mt-5 flex gap-2', align === 'end' ? 'flex-row-reverse justify-start' : 'justify-start')} onKeyDown={(event) => moveBetween(event, align === 'end')}>
        {/* Items of the menu, so that the arrow keys go between them, and either closes it. */}
        <Menu.Item render={(props) => <Button {...props}>Cancel</Button>} />
        <Menu.Item onClick={onConfirm} render={(props) => <Button {...props} variant="danger">{confirmLabel}</Button>} />
      </div>
    </div>
  </DropdownMenu>
)
