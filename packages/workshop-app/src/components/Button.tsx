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
     * `primary` is the one action a surface asks for.
     */
    variant?: 'secondary' | 'ghost' | 'primary'
    className?: string
  }

const VARIANT = {
  secondary: 'bg-kumo-base text-kumo-default ring-1 ring-kumo-line not-data-disabled:hover:bg-kumo-tint',
  ghost: 'bg-transparent text-kumo-default not-data-disabled:hover:bg-kumo-tint',
  primary: 'bg-kumo-contrast text-kumo-inverse not-data-disabled:hover:opacity-85',
} as const

const renderIcon = (icon: ButtonProps['icon']): ReactNode => {
  if (!icon) return undefined
  if (isValidElement(icon)) return icon
  const Icon = icon
  return <Icon />
}

/**
 * The one button size: 36px tall and fully rounded. With only an `icon` it is a 36px circle; with
 * text it stretches and keeps round ends.
 */
export const Button = ({ icon, children, variant = 'secondary', className, ...props }: ButtonProps) => {
  const iconNode = renderIcon(icon)
  const iconOnly = iconNode !== undefined && children === undefined

  return (
    <BaseButton
      type="button"
      className={cn(
        'inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full text-base font-medium whitespace-nowrap',
        'data-disabled:opacity-50',
        VARIANT[variant],
        '[&>svg]:size-[1.125em] [&>svg]:shrink-0',
        iconOnly ? 'w-9 p-0' : iconNode ? 'pr-4 pl-3' : 'px-4',
        className,
      )}
      {...props}
    >
      {iconNode}
      {children}
    </BaseButton>
  )
}
