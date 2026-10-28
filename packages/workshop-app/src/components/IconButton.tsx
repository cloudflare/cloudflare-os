import type { ComponentProps } from 'react'
import { Button as KumoButton } from '@cloudflare/kumo'

type KumoButtonProps = ComponentProps<typeof KumoButton>

export type IconButtonProps = Omit<
  KumoButtonProps,
  'variant' | 'shape' | 'children' | 'icon' | 'aria-label'
> & {
  /** Phosphor icon component or element. */
  icon: NonNullable<KumoButtonProps['icon']>
  /** Accessible name; an icon-only button has no visible text. */
  label: string
  variant?: 'secondary' | 'ghost'
}

/** A circular icon-only button. */
export const IconButton = ({ icon, label, variant = 'secondary', ...props }: IconButtonProps) => (
  <KumoButton variant={variant} shape="circle" icon={icon} aria-label={label} {...props} />
)
