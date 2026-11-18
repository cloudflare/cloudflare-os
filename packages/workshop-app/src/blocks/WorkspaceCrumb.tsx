import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'

export type WorkspaceCrumbProps = {
  id: string
  title: string
  /** Two letters shown on the icon. */
  label: string
  /** How its icon is drawn, when not as any workspace's is. */
  look?: WorkspaceLook
  /** Shows the title beside the icon. Otherwise the crumb is the icon alone, in a circle. */
  expanded?: boolean
  onOpen?: () => void
}

/**
 * A workspace in a page's header: its icon, and on its own page its title too. Going between a
 * workspace and one of its chats keeps the crumb, which grows the title out of the icon or draws
 * it back in. Going to another workspace swaps the crumb for that one's.
 */
export const WorkspaceCrumb = ({ id, title, label, look, expanded = false, onOpen }: WorkspaceCrumbProps) => (
  // Cut off where the header hasn't room for all of it, as beside a pane on a small laptop.
  <HeaderBubble name={`workspace:${id}`} state={expanded} className="min-w-0">
    {(wasExpanded) => (
      <Button
        // The icon keeps the circle's square, so the title grows out to the side of it.
        icon={<span className="grid size-(--control-size) shrink-0 place-items-center"><WorkspaceIcon label={label} {...look} small /></span>}
        aria-label={title}
        title={expanded ? undefined : title}
        onClick={onOpen}
        className="min-w-0 shrink gap-0 p-0"
      >
        <span
          className={cn(
            'grid min-w-0 transition-[grid-template-columns] duration-300 ease-out motion-reduce:transition-none',
            expanded ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]',
            // Where it starts from when it carries on from the crumb of the page before.
            wasExpanded !== undefined && (wasExpanded ? 'starting:grid-cols-[1fr]' : 'starting:grid-cols-[0fr]'),
          )}
        >
          <span className="min-w-0 overflow-hidden">
            <span className="block truncate pr-(--control-pad) pl-px">{title}</span>
          </span>
        </span>
      </Button>
    )}
  </HeaderBubble>
)
