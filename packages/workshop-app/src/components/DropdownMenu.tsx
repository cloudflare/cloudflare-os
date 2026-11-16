import { createElement, isValidElement, useRef, type CSSProperties, type ElementType, type ReactElement, type ReactNode, type RefObject } from 'react'
import { Menu } from '@cloudflare/kumo/primitives/menu'
import { cn } from '@cloudflare/kumo/utils'
import { CaretDownIcon, CaretRightIcon, CheckIcon, XIcon } from '@phosphor-icons/react'
import { Button, type ButtonProps } from './Button'
import { useMenuMorph } from './useMenuMorph'
import './DropdownMenu.css'

type TriggerContent =
  | { label: ReactNode; icon?: ElementType | ReactElement; 'aria-label'?: string }
  // Without visible text the trigger needs an accessible name.
  | { label?: undefined; icon: ElementType | ReactElement; 'aria-label': string }

export type DropdownMenuProps = TriggerContent & {
  /** As a function, it is given the way to close the menu, for what closes it other than an item. */
  children: ReactNode | ((close: () => void) => ReactNode)
  /**
   * The menu holds something of its own to choose with, such as an `OptionPicker`, rather than
   * items: it is as wide as a submenu, and leaves the padding and the scrolling to what it holds.
   */
  picker?: boolean
  /** Sizes and styles the trigger Button; the morphing surface copies it. */
  triggerClassName?: string
  /** The trigger Button's variant. A ghost trigger has no surface, so the menu's fades in as it grows. */
  triggerVariant?: ButtonProps['variant']
  /** A chevron after the label, for a trigger that would otherwise read as a button that acts at once. */
  caret?: boolean
  /** Positions the popup against this element instead of the trigger. */
  anchorRef?: RefObject<HTMLElement | null>
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /**
   * Open over the trigger, keeping the popup's anchored corner where the trigger was. Otherwise the
   * popup opens beside the anchor and a ghost close button replaces the trigger, unless `keepTrigger`.
   */
  inPlace?: boolean
  /**
   * Leave the trigger showing as it is while the menu is open, rather than replacing it with a close
   * button. The menu then morphs out of a circle beside the trigger rather than out of the trigger
   * itself, so it never passes over it. Has no effect in place, where the popup covers the trigger.
   */
  keepTrigger?: boolean
  /** How long the opening morph takes, in milliseconds. Every other timing scales with it. */
  duration?: number
}

/** The opening morph's duration that the timings in DropdownMenu.css are written for. */
const BASE_DURATION = 420

// Sized by the `--menu-*` sizes in `styles.css`, which are larger on a narrow screen, as the
// buttons menus open from are. An icon that starts an item is the menu's size, whoever drew it.
const ITEM_CLASS =
  'flex cursor-pointer items-center gap-3 rounded-2xl px-(--menu-pad-x) py-(--menu-pad-y) text-(length:--menu-text) leading-(--menu-line) text-kumo-default outline-none ' +
  'data-highlighted:bg-kumo-tint data-disabled:cursor-default [&>svg]:size-(--menu-icon)'

const renderIcon = (icon: ElementType | ReactElement | undefined): ReactElement | undefined =>
  !icon ? undefined : isValidElement(icon) ? icon : createElement(icon)

/** A menu whose surface morphs out of its trigger Button along a curved path. */
const DropdownMenuRoot = ({
  icon,
  label,
  'aria-label': ariaLabel,
  children,
  picker = false,
  triggerClassName,
  triggerVariant,
  caret = false,
  anchorRef,
  side = 'bottom',
  align = 'start',
  inPlace = false,
  keepTrigger = false,
  duration = 360,
}: DropdownMenuProps) => {
  const { triggerRef, popupRef } = useMenuMorph()
  const actionsRef = useRef<Menu.Root.Actions>(null)
  const time = { '--menu-time': duration / BASE_DURATION } as CSSProperties
  const iconNode = renderIcon(icon)
  // In a span, so that it keeps a chevron's size rather than taking the Button's size for an icon.
  const labelNode = caret && label !== undefined
    ? <>{label}<span className="-me-1 flex"><CaretDownIcon aria-hidden="true" weight="bold" className="size-3" /></span></>
    : label
  const keepsTrigger = keepTrigger && !inPlace
  const closesFromTrigger = !inPlace && !keepsTrigger
  // Stays mounted: the × must persist while it fades out during the closing morph,
  // after Kumo has already reported the menu as closed.
  // A circle as tall as the trigger, at its start edge (where an icon sits) or its end edge.
  const close = closesFromTrigger && (
    <span aria-hidden="true" className={cn('dropdown-menu-close absolute inset-y-0 aspect-square', align === 'end' ? 'end-0' : 'start-0')}>
      <XIcon weight="bold" className="size-3.5" />
    </span>
  )

  return (
    <Menu.Root actionsRef={actionsRef}>
      <Menu.Trigger
        ref={triggerRef}
        data-in-place={inPlace || undefined}
        render={(props, { open }) => (
          <Button
            {...props}
            variant={triggerVariant}
            style={{ ...props.style, ...time }}
            icon={iconNode ? <>{iconNode}{close}</> : undefined}
            aria-label={open && closesFromTrigger ? 'Close menu' : ariaLabel}
            className={cn('dropdown-menu-trigger relative', triggerClassName)}
          >
            {iconNode ? labelNode : <>{labelNode}{close}</>}
          </Button>
        )}
      />
      <Menu.Portal>
        <Menu.Positioner
          anchor={inPlace ? triggerRef : anchorRef ?? triggerRef}
          side={side}
          align={align}
          sideOffset={({ side, anchor }) => {
            // In place, overlap the trigger entirely so the popup's near edge sits on the trigger's.
            if (inPlace) return side === 'top' || side === 'bottom' ? -anchor.height : -anchor.width
            // Open, a wide trigger is just the × circle at one end. Beside it, sit next to the
            // circle rather than past the rest of the button.
            const pastClose = anchorRef || keepsTrigger ? 0 : anchor.width - anchor.height
            const closeAtEnd = align === 'end'
            return (side === 'right' && !closeAtEnd) || (side === 'left' && closeAtEnd) ? 8 - pastClose : 8
          }}
          collisionPadding={12}
          className="z-50"
        >
          <Menu.Popup
            ref={popupRef}
            data-in-place={inPlace || undefined}
            data-keep-trigger={keepsTrigger || undefined}
            data-variant={triggerVariant}
            style={time}
            aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
            onKeyDownCapture={(event) => {
              // An IME's confirming Enter must not also select a menu action.
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
                event.stopPropagation()
              }
            }}
            className={cn(
              'dropdown-menu relative isolate max-h-[min(var(--available-height),24rem)] rounded-[21px] text-kumo-default outline-none',
              // A width of its own, or it would change with the options a picker is narrowed to.
              picker ? 'w-64 max-w-(--available-width)' : 'w-max max-w-[min(var(--available-width),28rem)]',
            )}
          >
            <div aria-hidden="true" className="dropdown-menu-surface pointer-events-none absolute -z-10 bg-kumo-base ring-1 ring-kumo-contrast/6">
              <div className="absolute inset-0 rounded-[inherit]" />
            </div>
            {/* A copy of the trigger rides the surface, so the button itself appears to morph. */}
            <div inert aria-hidden="true" className="dropdown-menu-ghost pointer-events-none absolute">
              <Button icon={iconNode} aria-label="" tabIndex={-1} variant={triggerVariant} className={cn(triggerClassName, 'h-full w-full')}>
                {labelNode}
              </Button>
            </div>
            <div className="dropdown-menu-content max-h-[inherit]">
              <div
                className={cn(
                  'dropdown-menu-items max-h-[inherit] rounded-[inherit]',
                  picker ? 'flex flex-col overflow-hidden' : 'overflow-y-auto overscroll-contain p-1.5',
                )}
              >
                {typeof children === 'function' ? children(() => actionsRef.current?.close()) : children}
              </div>
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

type DropdownMenuItemProps = {
  children: ReactNode
  icon?: ElementType
  onSelect?: () => void
  disabled?: boolean
  /** Text for typeahead when the children are not plain text. */
  label?: string
}

const DropdownMenuItem = ({ children, icon: Icon, onSelect, disabled, label }: DropdownMenuItemProps) => (
  <Menu.Item onClick={onSelect} disabled={disabled} label={label} className={ITEM_CLASS}>
    {Icon && <Icon aria-hidden="true" className="shrink-0" />}
    {children}
  </Menu.Item>
)

const DropdownMenuSeparator = () => <Menu.Separator className="mx-(--menu-pad-x) my-1 h-px bg-kumo-line" />

/** A line over items that says what they are a choice of: "Sort by". */
const DropdownMenuLabel = ({ children }: { children: ReactNode }) => (
  <div className="px-(--menu-pad-x) pt-2 pb-1 text-(length:--menu-detail-text) leading-(--menu-detail-line) text-kumo-subtle">{children}</div>
)

// The tick an item that is chosen ends with. Its room is kept, so that choosing moves nothing.
const TICK_SLOT = 'ms-auto grid size-(--menu-icon) shrink-0 place-items-center'
const tick = <CheckIcon aria-hidden="true" weight="bold" className="size-(--menu-icon)" />

type DropdownMenuRadioGroupProps<Value extends string> = {
  value: Value
  onValueChange: (value: Value) => void
  /** What its items are a choice of: "Sort by". */
  'aria-label': string
  /** The choices (`DropdownMenu.RadioItem`). */
  children: ReactNode
}

/** Items of which one is chosen. */
const DropdownMenuRadioGroup = <Value extends string>({ value, onValueChange, 'aria-label': label, children }: DropdownMenuRadioGroupProps<Value>) => (
  <Menu.RadioGroup value={value} onValueChange={(next: Value) => onValueChange(next)} aria-label={label}>{children}</Menu.RadioGroup>
)

/** One choice of a `DropdownMenu.RadioGroup`, ticked while it is the one chosen. Choosing closes the menu. */
const DropdownMenuRadioItem = ({ value, children }: { value: string; children: ReactNode }) => (
  <Menu.RadioItem value={value} closeOnClick className={ITEM_CLASS}>
    {children}
    <span className={TICK_SLOT}><Menu.RadioItemIndicator>{tick}</Menu.RadioItemIndicator></span>
  </Menu.RadioItem>
)

type DropdownMenuSwatchGroupProps<Value extends string> = {
  value: Value
  onValueChange: (value: Value) => void
  /** What its swatches are a choice of: "Color". */
  'aria-label': string
  /** The choices (`DropdownMenu.Swatch`). */
  children: ReactNode
}

/** Choices that are drawn rather than named, such as icons or colours, four to a line, of which one is chosen. */
const DropdownMenuSwatchGroup = <Value extends string>({ value, onValueChange, 'aria-label': label, children }: DropdownMenuSwatchGroupProps<Value>) => (
  <Menu.RadioGroup value={value} onValueChange={(next: Value) => onValueChange(next)} aria-label={label} className="grid grid-cols-4">{children}</Menu.RadioGroup>
)

type DropdownMenuSwatchProps = {
  value: string
  /** What it is, as it is not said in the menu: "Red". */
  label: string
  /** What it is drawn as. */
  children: ReactNode
}

/**
 * One choice of a `DropdownMenu.SwatchGroup`, on a darker tile while it is the one chosen. The
 * menu stays open, so that the choice is seen where it is made for, and another can be made.
 */
const DropdownMenuSwatch = ({ value, label, children }: DropdownMenuSwatchProps) => (
  <Menu.RadioItem
    value={value}
    label={label}
    aria-label={label}
    title={label}
    className="grid size-12 cursor-pointer place-items-center rounded-2xl outline-none not-data-checked:data-highlighted:bg-kumo-tint data-checked:bg-kumo-contrast/8 data-checked:data-highlighted:bg-kumo-contrast/12"
  >
    {children}
  </Menu.RadioItem>
)

type DropdownMenuCheckboxItemProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
}

/** An item that is on or off, ticked while on. The menu stays open, so that several can be set. */
const DropdownMenuCheckboxItem = ({ checked, onCheckedChange, children }: DropdownMenuCheckboxItemProps) => (
  <Menu.CheckboxItem checked={checked} onCheckedChange={(next) => onCheckedChange(next)} className={ITEM_CLASS}>
    {children}
    <span className={TICK_SLOT}><Menu.CheckboxItemIndicator>{tick}</Menu.CheckboxItemIndicator></span>
  </Menu.CheckboxItem>
)

type DropdownMenuSubmenuProps = {
  /** What the menu is of, as its item in the menu it opens from. */
  label: string
  icon?: ElementType
  /** What the item says of the menu before it is opened, such as how many of its options are on. */
  detail?: ReactNode
  /** What the menu holds: items, or something of its own to choose with, such as an `OptionPicker`. */
  children: ReactNode
}

/**
 * An item that opens a menu of its own beside the one it is in, for what there is too much of to
 * list in place. It opens when pointed at or with the arrow key towards it, and is simply there:
 * only the menu it opens from morphs out of a button.
 */
const DropdownMenuSubmenu = ({ label, icon: Icon, detail, children }: DropdownMenuSubmenuProps) => (
  <Menu.SubmenuRoot>
    <Menu.SubmenuTrigger className={cn(ITEM_CLASS, 'data-popup-open:bg-kumo-tint')}>
      {Icon && <Icon aria-hidden="true" className="shrink-0" />}
      {label}
      <span className="ms-auto flex items-center gap-2 text-kumo-subtle">
        {detail}
        <CaretRightIcon aria-hidden="true" weight="bold" className="size-3" />
      </span>
    </Menu.SubmenuTrigger>
    <Menu.Portal>
      <Menu.Positioner sideOffset={10} alignOffset={-6} collisionPadding={12} className="z-50">
        <Menu.Popup
          aria-label={label}
          className="flex max-h-[min(var(--available-height),24rem)] w-64 max-w-[var(--available-width)] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-[21px] bg-kumo-base text-kumo-default ring-1 ring-kumo-contrast/6 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none"
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.SubmenuRoot>
)

export const DropdownMenu = Object.assign(DropdownMenuRoot, {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Label: DropdownMenuLabel,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  SwatchGroup: DropdownMenuSwatchGroup,
  Swatch: DropdownMenuSwatch,
  CheckboxItem: DropdownMenuCheckboxItem,
  Submenu: DropdownMenuSubmenu,
})
