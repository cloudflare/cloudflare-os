import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'

export type PromoItem = {
  key: string
  title: string
  /** What it is, in a word, for a reader: "Document". */
  kind: string
  icon?: FormatIconName
  href?: string
  onSelect: () => void
}

export type PromoCarouselProps = {
  /** What it promotes, in a sentence: the banner's heading. */
  title: string
  /** A line more of it, under the heading. */
  description?: string
  items: PromoItem[]
}

// The workspace colours (`theme.css`), two to a tile, from one to the next round the wheel, so that
// the tiles are as colourful as the workspaces' icons and no more. The same in either theme, as
// those are, with the icons' ink on them.
const TONES = [
  'from-(--color-workspace-blue) to-(--color-workspace-purple)',
  'from-(--color-workspace-orange) to-(--color-workspace-pink)',
  'from-(--color-workspace-teal) to-(--color-workspace-green)',
  'from-(--color-workspace-purple) to-(--color-workspace-pink)',
  'from-(--color-workspace-red) to-(--color-workspace-orange)',
  'from-(--color-workspace-green) to-(--color-workspace-blue)',
]

// A soft light in a tile's upper corner, in its ink, so that the colour has some depth.
const GLOW = 'bg-[radial-gradient(circle_at_25%_15%,color-mix(in_oklch,var(--color-workspace-ink)_35%,transparent),transparent_60%)]'

/** How long a tile is shown before the next comes along. */
const DWELL = 5000

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A banner that makes something of a few items: a heading and a line on the tinted surface, then
 * a tile each, in the workspaces' colours, along a line that runs out under the banner's end. The
 * line moves on by a tile every few seconds, and back to its start from its end, while it is not
 * pointed at and has no focus in it, and not at all with reduced motion. The arrows move it by a
 * tile either way.
 */
export const PromoCarousel = ({ title, description, items }: PromoCarouselProps) => {
  const id = useId()
  const rowRef = useRef<HTMLDivElement>(null)
  // Pointed at or focused, which holds it still.
  const [held, setHeld] = useState(false)

  const move = (way: 1 | -1) => {
    const row = rowRef.current
    if (!row) return
    const tile = row.firstElementChild as HTMLElement | null
    const step = (tile?.offsetWidth ?? row.clientWidth) + 12
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1
    const atStart = row.scrollLeft <= 1
    const behavior = reducedMotion() ? 'auto' : 'smooth'
    if (way === 1 && atEnd) row.scrollTo({ left: 0, behavior })
    else if (way === -1 && atStart) row.scrollTo({ left: row.scrollWidth, behavior })
    else row.scrollBy({ left: way * step, behavior })
  }

  useEffect(() => {
    if (held || items.length < 2 || reducedMotion()) return
    const timer = setInterval(() => move(1), DWELL)
    return () => clearInterval(timer)
  }, [held, items.length])

  return (
    <section
      aria-roledescription="carousel"
      aria-labelledby={id}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false)
      }}
      className="flex items-center gap-8 overflow-hidden rounded-3xl bg-kumo-tint py-6 ps-6 max-md:flex-col max-md:items-stretch max-md:gap-5"
    >
      <div className="flex w-64 shrink-0 flex-col gap-4 max-md:w-auto max-md:pe-6">
        <div className="flex flex-col gap-1.5">
          <h2 id={id} className="text-lg leading-snug font-medium text-kumo-default">{title}</h2>
          {description && <p className="text-sm text-kumo-subtle">{description}</p>}
        </div>
        {items.length > 1 && (
          <div className="flex items-center gap-2">
            <Button icon={ArrowLeftIcon} aria-label="Previous" title="Previous" onClick={() => move(-1)} />
            <Button icon={ArrowRightIcon} aria-label="Next" title="Next" onClick={() => move(1)} />
          </div>
        )}
      </div>
      {/* Out to the banner's end, under which the last on the line runs. */}
      <div ref={rowRef} className="flex min-w-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pe-6 [scrollbar-width:none] *:shrink-0 *:snap-start">
        {items.map(({ key, title: name, kind, icon, href, onSelect }, place) => (
          <LinkButton
            key={key}
            href={href}
            onClick={onSelect}
            className={cn(
              // Darkened a little when pointed at, as a card is, whatever its colours.
              'relative flex aspect-4/3 w-52 cursor-pointer flex-col justify-between overflow-hidden rounded-[1.25rem] bg-linear-to-br p-4 text-left text-(--color-workspace-ink) transition-[filter] duration-75 hover:brightness-90 focus-visible:brightness-90',
              TONES[place % TONES.length],
            )}
          >
            <span aria-hidden="true" className={cn('absolute inset-0', GLOW)} />
            <FormatIcon name={icon} weight="duotone" className="relative size-10" />
            <span className="relative line-clamp-2 text-base leading-snug font-semibold">
              {name}
              <span className="sr-only">, {kind}</span>
            </span>
          </LinkButton>
        ))}
      </div>
    </section>
  )
}
