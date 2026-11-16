import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'

export type HeaderCrumbProps = {
  /** Which crumb it is, from one page to the next (`HeaderBubble`'s `name`): `workspace:<id>`. */
  name: string
  /** What it is drawn as, in the circle. */
  icon: ReactNode
  title: string
  /** Shows the title beside the icon. Otherwise the crumb is the icon alone, in a circle. */
  expanded?: boolean
  onOpen?: () => void
}

/**
 * A place in a page's header, such as a workspace or an agent: its icon, and on its own page its
 * title too. Going between it and what is in it keeps the crumb, which grows the title out of the
 * icon or draws it back in. Going to another swaps the crumb for that one's.
 */
export const HeaderCrumb = ({ name, icon, title, expanded = false, onOpen }: HeaderCrumbProps) => (
  <HeaderBubble name={name} state={expanded}>
    {(wasExpanded) => (
      <Button
        // The icon keeps the circle's square, so the title grows out to the side of it.
        icon={<span className="grid size-(--control-size) place-items-center">{icon}</span>}
        aria-label={title}
        title={expanded ? undefined : title}
        onClick={onOpen}
        className="gap-0 p-0"
      >
        <span
          className={cn(
            'grid transition-[grid-template-columns] duration-300 ease-out motion-reduce:transition-none',
            expanded ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]',
            // Where it starts from when it carries on from the crumb of the page before.
            wasExpanded !== undefined && (wasExpanded ? 'starting:grid-cols-[1fr]' : 'starting:grid-cols-[0fr]'),
          )}
        >
          <span className="min-w-0 overflow-hidden">
            <span className="block pr-(--control-pad) pl-px">{title}</span>
          </span>
        </span>
      </Button>
    )}
  </HeaderBubble>
)
