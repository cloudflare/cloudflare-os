import { useId, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { cloudLobes, sparkle } from './mascot/shapes'

/** The illustrations there are, each for a thing the app offers to do. */
export type IllustrationName = 'invite' | 'template'

// One person among others, a plain disc, with a ring in the page's colour that parts it from the next.
const Avatar = ({ x }: { x: number }) => (
  <g>
    <circle cx={x} cy="46" r="12" className="fill-kumo-base" />
    <circle cx={x} cy="46" r="10" className="fill-kumo-contrast" />
  </g>
)

// A surface in the page's opposite colour with a little of the page's own over it: the lighter
// layer of a workspace's folder, which is quieter than the black.
const Soft = ({ amount, children }: { amount: number; children: (paint: { className?: string; fill?: string; fillOpacity?: number }) => ReactNode }) => (
  <g>
    {children({ className: 'fill-kumo-contrast' })}
    {children({ fill: 'currentColor', fillOpacity: amount })}
  </g>
)

// The mascot's cloud, as its four circles, for what it is told: `grow` widens each by that much all
// round, and `dash` is the length of a dash and of the gap after it.
const Cloud = ({ grow = 0, dash, fill, className }: { grow?: number; dash?: string; fill?: string; className?: string }) => (
  <g className={className} fill={fill} strokeWidth={2 * grow} strokeDasharray={dash} strokeLinejoin="round">
    {cloudLobes.map(({ x, y, radius }) => <circle key={`${x}:${y}`} cx={x} cy={y} r={radius} />)}
  </g>
)

// The cloud's width and height, so that two of them fit a square one behind the other.
const CLOUD_HEIGHT = 55.8
const SCALE = 0.76
const FRONT = `translate(3 ${64 - CLOUD_HEIGHT * SCALE - 2}) scale(${SCALE})`
const BEHIND = `translate(10 5) scale(${SCALE})`
// How much of the outlined cloud is filled, as the mask lets through: its colour at a tenth.
const FILLED = 'rgb(26 26 26)'
// How far the outline stands out of the cloud behind, how it is dashed, and the gap cut round the
// one in front, in the cloud's own units. The dashes are of each circle's edge: what falls inside
// the cloud is covered by it.
const LINE = 2.2 / SCALE
const DASH = '6 6'
const GAP = 2.4 / SCALE

/**
 * A square illustration in the style of the workspace icons: solid, rounded shapes in the colours
 * of the viewer's own messages, so the page's opposite, with details in the page's colour. Sized by
 * its `className`, 64 by default.
 */
export const Illustration = ({ name, className }: { name: IllustrationName; className?: string }) => {
  const outline = useId()
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={cn('size-16 shrink-0 text-kumo-inverse', className)}>
      {name === 'invite' ? (
        <>
          {/* One app, and several people along its foot, who use it together. */}
          <Soft amount={0.16}>{(paint) => <rect x="7" y="6" width="50" height="40" rx="13" {...paint} />}</Soft>
          <circle cx="16" cy="14" r="2.2" fill="currentColor" />
          <circle cx="22.5" cy="14" r="2.2" fill="currentColor" />
          <circle cx="29" cy="14" r="2.2" fill="currentColor" />
          <Avatar x={47} />
          <Avatar x={32} />
          <Avatar x={17} />
        </>
      ) : (
        <>
          {/* The mascot, and a dashed outline of one behind it, faintly filled, as a copy to start from. */}
          <defs>
            <mask id={outline}>
              <rect width="64" height="64" fill="black" />
              <g transform={BEHIND}>
                <Cloud grow={LINE} dash={DASH} className="fill-none stroke-white" />
                <Cloud fill={FILLED} />
              </g>
              <g transform={FRONT}>
                <Cloud grow={GAP} className="fill-black stroke-black" />
              </g>
            </mask>
          </defs>
          <rect width="64" height="64" mask={`url(#${outline})`} className="fill-kumo-contrast" />
          <g transform={FRONT}>
            <Cloud className="fill-kumo-contrast" />
            <path d={sparkle} fill="currentColor" />
          </g>
        </>
      )}
    </svg>
  )
}
