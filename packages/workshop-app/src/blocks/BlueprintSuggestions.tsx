import type { ReactElement } from 'react'
import { KindMark } from '@/components/KindMark'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { BlueprintPicture } from './BlueprintTile'
import { CARD, CardHead, FanCard, SHEET } from './FanCard'

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
          <CardHead icon={blueprint.icon} title={blueprint.title} />
          <span className={cn(SHEET, 'absolute inset-x-3 top-10 -bottom-3 transition-[translate,box-shadow] duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-[0_2px_4px_rgb(0_0_0/0.08),0_12px_24px_-8px_rgb(0_0_0/0.18)] motion-reduce:transition-none')}>
            <BlueprintPicture picture={blueprint.picture} icon={blueprint.icon} className="aspect-auto h-full bg-kumo-base" />
          </span>
        </LinkButton>
      ))}
      <FanCard
        title="All blueprints"
        icon={<KindMark name="collection" />}
        sheets={more.map((picture, at) => picture && <img key={at} src={picture} alt="" className="size-full object-cover object-top" />)}
        href={browseHref}
        onOpen={onBrowse}
        index={blueprints.length}
      />
    </div>
  </section>
)
