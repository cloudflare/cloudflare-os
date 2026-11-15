import type { ReactElement, ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'

export type FanCardProps = {
  /** Where it goes: "All blueprints". */
  title: string
  icon: ReactElement
  /** Under the title, such as how many there are; the sheets then stand lower, as a two-line head's do. */
  detail?: string
  /** What is drawn on the three sheets, the front one first; any left out is a blank sheet. */
  sheets: readonly ReactNode[]
  href?: string
  onOpen: () => void
  /** Where it falls in its row, for coming in a beat after the one before. */
  index?: number
  /** It fades in as it is first drawn, a beat after the one before (`index`). */
  entrance?: boolean
}

export const CARD = 'group relative flex aspect-[4/3] w-full min-w-0 flex-col overflow-hidden rounded-2xl bg-kumo-contrast/5 text-left ring-1 ring-kumo-contrast/6 outline-none transition-[scale,background-color] duration-150 ease-out hover:bg-kumo-contrast/7 focus-visible:ring-2 focus-visible:ring-kumo-ring active:scale-[0.97] motion-reduce:transition-none'

/** A card's fade as it is first drawn, a beat after the one before (its `animationDelay`). */
export const ENTRANCE = 'appears [animation-fill-mode:backwards]'

/** A sheet of paper standing in a card: a white page's edge still shows against the card in light. */
export const SHEET = 'overflow-hidden rounded-t-lg bg-kumo-base shadow-[0_1px_2px_rgb(0_0_0/0.1),0_8px_20px_-8px_rgb(0_0_0/0.22)] ring-1 ring-kumo-contrast/12'

/** A card's head: its icon (left out when narrow, where the name needs the room more), its name, and a line under it. */
export const CardHead = ({ icon, title, detail }: { icon: ReactElement; title: string; detail?: ReactNode }) => (
  <span className="flex min-w-0 flex-col gap-0.5 p-3">
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="hidden shrink-0 text-kumo-subtle sm:flex [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 truncate text-xs/4 font-medium text-kumo-default">{title}</span>
    </span>
    {detail && <span className="flex min-w-0 truncate text-xs/4 text-kumo-subtle">{detail}</span>}
  </span>
)

// The three sheets of the fan, back to front: each turned out from its foot, and further when pointed at.
const FAN = [
  'rotate-[-9deg] -translate-x-[22%] group-hover:rotate-[-14deg] group-hover:-translate-x-[34%]',
  'rotate-[9deg] translate-x-[22%] group-hover:rotate-[14deg] group-hover:translate-x-[34%]',
  'group-hover:-translate-y-1.5',
]

/**
 * The card at the end of a row of cards that goes to all of what they are a few of: headed by
 * where it goes, with a fan of three sheets standing out of its foot that spreads when pointed at.
 */
export const FanCard = ({ title, icon, detail, sheets, href, onOpen, index = 0, entrance = true }: FanCardProps) => (
  <LinkButton href={href} onClick={onOpen} title={detail ? `${title}, ${detail}` : title} style={entrance ? { animationDelay: `${index * 60}ms` } : undefined} className={cn(CARD, entrance && ENTRANCE)}>
    <CardHead icon={icon} title={title} detail={detail} />
    <span aria-hidden="true" className={cn('absolute inset-x-0 -bottom-3', detail ? 'top-[3.875rem]' : 'top-11')}>
      {FAN.map((turn, at) => (
        <span
          key={at}
          className={cn(SHEET, 'absolute inset-y-0 left-1/2 w-[58%] -ml-[29%] origin-bottom transition-[rotate,translate] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none', turn)}
        >
          {/* Back to front: the front one is the last drawn, and the first given. */}
          {sheets[(at + 1) % FAN.length]}
        </span>
      ))}
    </span>
  </LinkButton>
)
