import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type ServiceLogoProps = {
  /** What it is the logo of, whose initial stands in while it has no picture. */
  name: string
  src?: string
  /** The service's own colour, behind its logo, as the service gives it. */
  color?: string
  /** `sm` in a row of a list, `lg` heading a dialog. */
  size?: 'sm' | 'lg'
}

const SIZE = {
  sm: { tile: 'size-7 rounded-[9px]', logo: 'size-4', initial: 'text-xs' },
  lg: { tile: 'size-10 rounded-xl', logo: 'size-5', initial: 'text-sm' },
} as const

/**
 * A connected service's mark on a rounded tile of its colour, or of the page's tint when it gives
 * none. One whose picture does not load shows its initial instead.
 */
export const ServiceLogo = ({ name, src, color, size = 'sm' }: ServiceLogoProps) => {
  // The picture that failed, so a new one is tried.
  const [failed, setFailed] = useState<string>()
  const { tile, logo, initial } = SIZE[size]
  return (
    <span
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center overflow-hidden bg-kumo-tint ring-1 ring-kumo-line ring-inset', tile)}
      style={color ? { backgroundColor: color } : undefined}
    >
      {src && failed !== src
        ? <img src={src} alt="" className={cn('object-contain', logo)} onError={() => setFailed(src)} />
        : <span className={cn('font-semibold text-kumo-default', initial)}>{name.slice(0, 1).toUpperCase()}</span>}
    </span>
  )
}
