import { ServiceLogo } from './ServiceLogo'
import { Tooltip } from '@gadgets/ui'

export type ServiceStackProps = {
  services: { name: string; logoUrl?: string; color?: string }[]
  /** What they have in common, ahead of each one's name where it is pointed at: "Needs". */
  label: string
}

// More than this, and the last place says how many more there are.
const SHOWN = 3

// A logo says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

// A tile is 24px with 8px corners (`ServiceLogo`'s `tiny`), as large as the creator's picture
// beside it, and the next overlaps it by 6px (`-space-x-1.5`). Each is cut away under the next, and 2px round it,
// as rounded as the next is plus that, so that what is behind the stack shows between them,
// whatever it is and however it changes, as a card does when it is pointed at. A gap drawn in a
// colour would be the surface's only until that changed.
const CUT = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><mask id="m"><rect width="24" height="24" fill="white"/><rect x="16" y="-2" width="28" height="28" rx="10" fill="black"/></mask><rect width="24" height="24" fill="white" mask="url(#m)"/></svg>',
)}")`

/**
 * A few services' logos, as large as the picture of who made what needs them, and overlapping as people's pictures are
 * (`AvatarStack`), each saying which it is when pointed at, with a gap between one and the next
 * through which what is behind shows.
 */
export const ServiceStack = ({ services, label }: ServiceStackProps) => {
  const shown = services.length > SHOWN ? services.slice(0, SHOWN - 1) : services
  const rest = services.slice(shown.length)
  const tiles = shown.length + (rest.length > 0 ? 1 : 0)

  return (
    <span role="group" aria-label={label} className="flex shrink-0 items-center -space-x-1.5">
      {shown.map(({ name, logoUrl, color }, place) => (
        <Tooltip key={name} delay={TOOLTIP_DELAY} content={`${label} ${name}`}>
          {/* Cut under the next, unless it is the last. */}
          <span role="img" aria-label={name} className="flex" style={place < tiles - 1 ? { maskImage: CUT } : undefined}>
            <ServiceLogo name={name} src={logoUrl} color={color} tiny />
          </span>
        </Tooltip>
      ))}
      {rest.length > 0 && (
        <Tooltip delay={TOOLTIP_DELAY} content={`${label} ${rest.map(({ name }) => name).join(', ')}`}>
          <span role="img" aria-label={`${rest.length} more: ${rest.map(({ name }) => name).join(', ')}`} className="grid size-6 place-items-center rounded-lg bg-kumo-base text-[0.625rem] font-medium text-kumo-subtle tabular-nums">
            +{rest.length}
          </span>
        </Tooltip>
      )}
    </span>
  )
}
