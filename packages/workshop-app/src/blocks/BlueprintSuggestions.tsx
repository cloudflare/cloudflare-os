import type { ReactElement } from 'react'
import { ArrowRightIcon } from '@phosphor-icons/react'
import { LinkButton } from '@/components/LinkButton'
import { BlueprintPicture } from './BlueprintTile'

/** A blueprint as Home suggests it. */
export type SuggestedBlueprint = { id: string; title: string; picture?: string; icon: ReactElement; href?: string }

export type BlueprintSuggestionsProps = {
  blueprints: readonly SuggestedBlueprint[]
  onOpen: (id: string) => void
  /** Goes to every blueprint, in the Library. */
  onBrowse: () => void
  browseHref?: string
}

/**
 * A few blueprints to start from, under Home's composer: each a small card of its picture and its
 * name, which opens its page, and the way to the rest. Quiet beside the composer, as most start by
 * asking; it comes in once they are read, and is not there at all while there are none.
 */
export const BlueprintSuggestions = ({ blueprints, onOpen, onBrowse, browseHref }: BlueprintSuggestionsProps) => (
  <section aria-label="Start from a blueprint" className="appears flex w-full flex-col gap-3">
    <div className="flex items-center justify-between px-1">
      <h2 className="text-sm font-medium text-kumo-subtle">Or start from a blueprint</h2>
      <LinkButton href={browseHref} onClick={onBrowse} className="flex items-center gap-1 rounded-full text-sm text-kumo-subtle outline-none hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring">
        All blueprints
        <ArrowRightIcon aria-hidden="true" weight="bold" className="size-3" />
      </LinkButton>
    </div>
    <div className="grid grid-cols-3 gap-3">
      {blueprints.map((blueprint) => (
        <LinkButton
          key={blueprint.id}
          href={blueprint.href}
          onClick={() => onOpen(blueprint.id)}
          title={blueprint.title}
          className="group flex min-w-0 flex-col gap-1.5 rounded-xl text-left outline-none transition-[scale] duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none"
        >
          <span className="block overflow-hidden rounded-xl ring-1 ring-kumo-contrast/6 group-focus-visible:ring-2 group-focus-visible:ring-kumo-ring">
            <BlueprintPicture picture={blueprint.picture} icon={blueprint.icon} className="transition-[scale] duration-300 ease-out group-hover:scale-[1.04] motion-reduce:transition-none" />
          </span>
          <span className="truncate px-0.5 text-sm text-kumo-subtle group-hover:text-kumo-default">{blueprint.title}</span>
        </LinkButton>
      ))}
    </div>
  </section>
)
