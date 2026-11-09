import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'
import { Tooltip } from '@cloudflare/kumo'

// The Cloudflare OS design's "Round Btn": a white circle with a hairline ring, holding a 16px icon
// or a short label. Kumo's Button can't render as a router link and adds a shadow and text lift the
// design doesn't have, so the same look is shared here for buttons and links alike.
const SHAPE = {
  icon: 'size-[34px] justify-center',
  pill: 'h-[34px] gap-1.5 px-3 text-[13px] font-medium leading-4',
} as const

/** The class list for a design round button, for controls that must render their own element. */
export const roundButtonClass = (shape: keyof typeof SHAPE = 'icon', className = '') => [
  'inline-flex shrink-0 cursor-pointer items-center rounded-full bg-kumo-base text-kumo-default',
  'ring-1 ring-kumo-line transition-colors hover:bg-kumo-elevated',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
  'disabled:cursor-not-allowed disabled:opacity-50',
  SHAPE[shape], className,
].join(' ')

type CommonProps = {
  /** Accessible name; also the tooltip for an icon-only button. */
  label: string
  children: ReactNode
  shape?: keyof typeof SHAPE
  className?: string
}

const withTooltip = (shape: keyof typeof SHAPE, label: string, element: React.ReactElement) =>
  shape === 'icon' ? <Tooltip content={label} render={element} /> : element

/** A design round button that runs an action. */
export const RoundButton = forwardRef<HTMLButtonElement,
  CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'>>(
  ({ label, children, shape = 'icon', className, type = 'button', ...rest }, ref) =>
    withTooltip(shape, label,
      <button ref={ref} type={type} aria-label={shape === 'icon' ? label : undefined}
        className={roundButtonClass(shape, className)} {...rest}>
        {children}
      </button>),
)
RoundButton.displayName = 'RoundButton'

/** A design round button that navigates. */
export const RoundLink = ({ label, children, shape = 'icon', className, ...link }:
  CommonProps & Omit<LinkProps, 'children' | 'className'>) =>
  withTooltip(shape, label,
    <Link aria-label={shape === 'icon' ? label : undefined} className={roundButtonClass(shape, className)} {...link}>
      {children}
    </Link>)
