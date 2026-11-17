import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type ServiceLogoProps = {
  /** What the service is called, whose first letter stands in for a logo it has none of. */
  name: string
  /** The logo's address. */
  src?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** As small as a row's picture, rather than a card's. */
  small?: boolean
  /** As small as a person's picture is at the end of a listed template, for several of them on a line (`ServiceStack`). */
  tiny?: boolean
  /**
   * Cut away round a 12px badge on its bottom right corner that stands 2px out from its edges,
   * leaving a 3px gap round the badge through which what is behind shows, whatever that is.
   */
  notched?: boolean
}

// The badge's middle is 4px in from each edge, and the cut 3px wider than its 6px radius.
const NOTCH = 'mask-[radial-gradient(circle_at_calc(100%-4px)_calc(100%-4px),transparent_9px,black_9.5px)]'

/**
 * The logo of a service the app connects to, on a tile of its own as an app's icon is, or the
 * first letter of its name where it has no logo, or its logo does not load.
 */
export const ServiceLogo = ({ name, src, color, small = false, tiny = false, notched = false }: ServiceLogoProps) => {
  // The address that did not load, so that another is tried.
  const [failed, setFailed] = useState<string>()
  const shown = src !== undefined && src !== failed

  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden bg-kumo-base font-medium text-kumo-subtle',
        // Its edge is a faint shadow inside it rather than a line around it, which a coloured tile
        // only darkens a little at its rim, as an app's icon is drawn.
        'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-kumo-contrast)_4%,transparent)]',
        tiny ? 'size-6 rounded-lg text-[0.625rem]' : small ? 'size-10 rounded-xl text-base' : 'size-12 rounded-[0.875rem] text-lg',
        notched && NOTCH,
        // A logo with no colour of its own was drawn for a light tile, as most are, often in black
        // that a dark one would lose: its tile is the light theme's in either, as an app's icon
        // stays as it was drawn.
        shown && !color && 'scheme-light',
      )}
      // Only behind a logo: some are a single colour drawn for their service's own, and are lost
      // on the tile's. A letter is in the theme's colour, which reads on the tile as it is.
      style={shown && color ? { backgroundColor: color } : undefined}
    >
      {shown
        ? <img src={src} alt="" className="size-3/5 object-contain" onError={() => setFailed(src)} />
        : name.trim().slice(0, 1).toUpperCase() || '?'}
    </span>
  )
}
