import type { ComponentProps } from 'react'
import { Button as KumoButton } from '@cloudflare/kumo'

type KumoButtonProps = ComponentProps<typeof KumoButton>

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'chip'

export type ButtonProps = Omit<KumoButtonProps, 'variant' | 'shape'> & {
  variant?: ButtonVariant
}

// Every Workshop button is a pill. Kumo's size classes set a rounded-lg that className overrides.
const PILL = 'rounded-full'

const VARIANTS: Record<ButtonVariant, { kumo: KumoButtonProps['variant']; className: string }> = {
  primary: {
    kumo: 'secondary',
    className: 'bg-kumo-contrast !text-kumo-inverse ring-0 not-disabled:hover:bg-kumo-contrast/90',
  },
  secondary: { kumo: 'secondary', className: '' },
  ghost: { kumo: 'ghost', className: '' },
  chip: { kumo: 'outline', className: '!text-kumo-subtle' },
}

/** A pill-shaped text button, with an optional leading `icon`. For icon-only actions use `IconButton`. */
export const Button = ({ variant = 'secondary', className, ...props }: ButtonProps) => {
  const { kumo, className: variantClassName } = VARIANTS[variant]
  return (
    <KumoButton
      variant={kumo}
      className={[PILL, variantClassName, className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
