import { createElement, isValidElement, type CSSProperties, type ElementType, type ReactElement, type ReactNode, type RefObject } from 'react'
import { Menu } from '@cloudflare/kumo/primitives/menu'
import { cn } from '@cloudflare/kumo/utils'
import { XIcon } from '@phosphor-icons/react'
import { Button, type ButtonProps } from './Button'
import { useMenuMorph } from './useMenuMorph'
import './DropdownMenu.css'

type TriggerContent =
  | { label: ReactNode; icon?: ElementType | ReactElement; 'aria-label'?: string }
  // Without visible text the trigger needs an accessible name.
  | { label?: undefined; icon: ElementType | ReactElement; 'aria-label': string }

export type DropdownMenuProps = TriggerContent & {
  children: ReactNode
  /** Sizes and styles the trigger Button; the morphing surface copies it. */
  triggerClassName?: string
  /** The trigger Button's variant. A ghost trigger has no surface, so the menu's fades in as it grows. */
  triggerVariant?: ButtonProps['variant']
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

const ITEM_CLASS = 'flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-base/5 text-kumo-default outline-none data-highlighted:bg-kumo-tint data-disabled:cursor-default'

const renderIcon = (icon: ElementType | ReactElement | undefined): ReactElement | undefined =>
  !icon ? undefined : isValidElement(icon) ? icon : createElement(icon)

/** A menu whose surface morphs out of its trigger Button along a curved path. */
const DropdownMenuRoot = ({
  icon,
  label,
  'aria-label': ariaLabel,
  children,
  triggerClassName,
  triggerVariant,
  anchorRef,
  side = 'bottom',
  align = 'start',
  inPlace = false,
  keepTrigger = false,
  duration = 360,
}: DropdownMenuProps) => {
  const { triggerRef, popupRef } = useMenuMorph()
  const time = { '--menu-time': duration / BASE_DURATION } as CSSProperties
  const iconNode = renderIcon(icon)
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
    <Menu.Root>
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
            {iconNode ? label : <>{label}{close}</>}
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
            className="dropdown-menu relative isolate max-h-[min(var(--available-height),24rem)] w-max max-w-[min(var(--available-width),28rem)] rounded-[21px] text-kumo-default outline-none"
          >
            <div aria-hidden="true" className="dropdown-menu-surface pointer-events-none absolute -z-10 bg-kumo-base ring-1 ring-kumo-contrast/6">
              <div className="absolute inset-0 rounded-[inherit]" />
            </div>
            {/* A copy of the trigger rides the surface, so the button itself appears to morph. */}
            <div inert aria-hidden="true" className="dropdown-menu-ghost pointer-events-none absolute">
              <Button icon={iconNode} aria-label="" tabIndex={-1} variant={triggerVariant} className={cn(triggerClassName, 'h-full w-full')}>
                {label}
              </Button>
            </div>
            <div className="dropdown-menu-content max-h-[inherit]">
              <div className="dropdown-menu-items max-h-[inherit] overflow-y-auto overscroll-contain rounded-[inherit] p-1.5">
                {children}
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
    {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
    {children}
  </Menu.Item>
)

const DropdownMenuSeparator = () => <Menu.Separator className="mx-3 my-1 h-px bg-kumo-line" />

export const DropdownMenu = Object.assign(DropdownMenuRoot, {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
})
