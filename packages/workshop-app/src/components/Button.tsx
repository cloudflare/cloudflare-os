import { isValidElement, type ComponentProps, type ElementType, type ReactElement, type ReactNode } from 'react'
import { Button as BaseButton } from '@cloudflare/kumo/primitives/button'
import { cn } from '@cloudflare/kumo/utils'

type BaseButtonProps = Omit<ComponentProps<typeof BaseButton>, 'children' | 'className' | 'aria-label'>

type ButtonContent =
  | { children: ReactNode; 'aria-label'?: string }
  // Without visible text the button needs an accessible name.
  | { children?: undefined; icon: ElementType | ReactElement; 'aria-label': string }

export type ButtonProps = BaseButtonProps &
  ButtonContent & {
    /** A Phosphor icon component, or an element (e.g. an avatar). Shown before `children`. */
    icon?: ElementType | ReactElement
    /**
     * `ghost` drops the fill and ring until hovered, for secondary actions inside another surface.
     * `primary` is the one action a surface asks for. `danger` is one that cannot be undone, such
     * as deleting: the secondary button, in the colour that says so.
     */
    variant?: 'secondary' | 'ghost' | 'primary' | 'danger'
    className?: string
  }

const VARIANT = {
  secondary: 'bg-kumo-base text-kumo-default ring-1 ring-kumo-line not-data-disabled:hover:bg-kumo-tint',
  ghost: 'bg-transparent text-kumo-default not-data-disabled:hover:bg-kumo-tint',
  primary: 'bg-kumo-contrast text-kumo-inverse not-data-disabled:hover:opacity-85',
  danger: 'bg-kumo-base text-kumo-danger ring-1 ring-kumo-line not-data-disabled:hover:bg-kumo-danger-tint',
} as const

const renderIcon = (icon: ButtonProps['icon']): ReactNode => {
  if (!icon) return undefined
  if (isValidElement(icon)) return icon
  const Icon = icon
  return <Icon />
}

/**
 * The one button size, fully rounded: 36px tall, and 44px on a narrow screen, for a thumb (the
 * `--control-*` sizes in `styles.css`). With only an `icon` it is a circle; with text it stretches
 * and keeps round ends.
 */
export const Button = ({ icon, children, variant = 'secondary', className, ...props }: ButtonProps) => {
  const iconNode = renderIcon(icon)
  const iconOnly = iconNode !== undefined && children === undefined

  return (
    <BaseButton
      type="button"
      className={cn(
        'inline-flex h-(--control-size) shrink-0 items-center justify-center gap-2 rounded-full text-(length:--control-text) leading-normal font-medium whitespace-nowrap',
        'data-disabled:opacity-50',
        VARIANT[variant],
        '[&>svg]:size-[1.125em] [&>svg]:shrink-0',
        iconOnly ? 'w-(--control-size) p-0' : iconNode ? 'pr-(--control-pad) pl-(--control-pad-icon)' : 'px-(--control-pad)',
        className,
      )}
      {...props}
    >
      {iconNode}
      {children}
    </BaseButton>
  )
}
