import type { ReactElement } from 'react'
import { SquaresFourIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { BlueprintPicture } from './BlueprintTile'

/** A blueprint as Home suggests it. */
export type SuggestedBlueprint = { id: string; title: string; picture?: string; icon: ReactElement; href?: string }

export type BlueprintSuggestionsProps = {
  /** The ones offered, two of them. */
  blueprints: readonly SuggestedBlueprint[]
  /** Pictures of a few, fanned on the card to all of them, the front one first; any missing is a blank sheet. */
  more?: readonly (string | undefined)[]
  onOpen: (id: string) => void
  /** Goes to every blueprint, in the Library. */
  onBrowse: () => void
  browseHref?: string
}

const CARD = 'appears group relative block aspect-[4/3] min-w-0 overflow-hidden rounded-2xl bg-kumo-contrast/5 text-left ring-1 ring-kumo-contrast/6 outline-none transition-[scale,background-color] duration-150 ease-out [animation-fill-mode:backwards] hover:bg-kumo-contrast/7 focus-visible:ring-2 focus-visible:ring-kumo-ring active:scale-[0.97] motion-reduce:transition-none'

// A sheet of paper standing in the card: a white page's edge still shows against the card in light.
const SHEET = 'overflow-hidden rounded-t-lg bg-kumo-base shadow-[0_1px_2px_rgb(0_0_0/0.1),0_8px_20px_-8px_rgb(0_0_0/0.22)] ring-1 ring-kumo-contrast/12'

const Head = ({ icon, children }: { icon: ReactElement; children: string }) => (
  <span className="flex min-w-0 items-center gap-1.5 p-3">
    {/* Left out when narrow, where the name needs the room more. */}
    <span className="hidden shrink-0 text-kumo-subtle sm:flex [&>svg]:size-3.5">{icon}</span>
    <span className="min-w-0 truncate text-xs/4 font-medium text-kumo-default">{children}</span>
  </span>
)

// The three sheets of the fan, back to front: each turned out from its foot, and further when pointed at.
const FAN = [
  'rotate-[-9deg] -translate-x-[22%] group-hover:rotate-[-14deg] group-hover:-translate-x-[34%]',
  'rotate-[9deg] translate-x-[22%] group-hover:rotate-[14deg] group-hover:translate-x-[34%]',
  'group-hover:-translate-y-1.5',
]

/**
 * A few blueprints to start from, under Home's composer, as cards like the Library's tiles: each
 * headed by its name, its picture a sheet standing up out of the card's foot that rises a little
 * when pointed at. The last card is the way to all of them, a fan of more of their pictures that
 * spreads when pointed at. They come in one after another, once read. Quiet beside the composer,
 * as most start by asking, and not there at all while there are none.
 */
export const BlueprintSuggestions = ({ blueprints, more = [], onOpen, onBrowse, browseHref }: BlueprintSuggestionsProps) => (
  <section aria-labelledby="start-from-blueprint" className="flex w-full flex-col gap-3">
    <h2 id="start-from-blueprint" className="appears px-1 text-sm text-kumo-subtle">Start from a blueprint</h2>
    <div className="grid grid-cols-3 gap-3">
      {blueprints.map((blueprint, index) => (
        <LinkButton
          key={blueprint.id}
          href={blueprint.href}
          onClick={() => onOpen(blueprint.id)}
          title={blueprint.title}
          // One after another, a beat apart, rather than all at once.
          style={{ animationDelay: `${index * 60}ms` }}
          className={CARD}
        >
          <Head icon={blueprint.icon}>{blueprint.title}</Head>
          <span className={cn(SHEET, 'absolute inset-x-3 top-10 -bottom-px transition-[translate,box-shadow] duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-[0_2px_4px_rgb(0_0_0/0.08),0_12px_24px_-8px_rgb(0_0_0/0.18)] motion-reduce:transition-none')}>
            <BlueprintPicture picture={blueprint.picture} icon={blueprint.icon} className="aspect-auto h-full bg-kumo-base" />
          </span>
        </LinkButton>
      ))}
      <LinkButton href={browseHref} onClick={onBrowse} style={{ animationDelay: `${blueprints.length * 60}ms` }} className={CARD}>
        <Head icon={<SquaresFourIcon />}>All blueprints</Head>
        <span aria-hidden="true" className="absolute inset-x-0 top-11 -bottom-px">
          {FAN.map((turn, index) => (
            <span
              key={index}
              className={cn(SHEET, 'absolute inset-y-0 left-1/2 w-[58%] -ml-[29%] origin-bottom transition-[rotate,translate] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none', turn)}
            >
              {more[(index + 1) % FAN.length] && <img src={more[(index + 1) % FAN.length]} alt="" className="size-full object-cover object-top" />}
            </span>
          ))}
        </span>
      </LinkButton>
    </div>
  </section>
)
