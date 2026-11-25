import { PlusSignIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton, Tooltip } from '@gadgets/ui'

export type NewWorkspaceRowProps = {
  /** Where a new workspace is started, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
  /** The page a new chat is started on is showing, which is where it goes: marked as a selected workspace is. */
  current?: boolean
  /** Its icon alone, on the collapsed sidebar's rail, with its words in a tooltip. */
  rail?: boolean
}

const SUBTITLE = 'Start with a chat'

// Where a workspace's icon would be: its size, outlined and dashed, as a place still to fill.
const Slot = ({ small }: { small?: boolean }) => (
  <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-lg border border-dashed border-kumo-line text-kumo-subtle', small ? 'h-5 w-5.5' : 'h-7.5 w-8')}>
    <PlusSignIcon weight="bold" className={small ? 'size-3' : 'size-3.5'} />
  </span>
)

/**
 * The sidebar's list with no workspaces in it: one quiet row where the first would be, with a
 * place for its icon, that starts a chat, which makes one. Rather than an empty state, which would
 * be louder than anything else in the sidebar.
 */
export const NewWorkspaceRow = ({ href, onSelect, current = false, rail = false }: NewWorkspaceRowProps) =>
  rail
    ? (
        <Tooltip
          side="right"
          content={(
            <>
              <span className="block font-medium">New workspace</span>
              <span className="block text-kumo-subtle">{SUBTITLE}</span>
            </>
          )}
        >
          <LinkButton
            href={href}
            onClick={onSelect}
            aria-label="New workspace"
            aria-current={current ? 'page' : undefined}
            className={cn('grid size-10 place-items-center rounded-xl hover:bg-kumo-contrast/8', current && 'bg-kumo-contrast/8')}
          >
            <Slot small />
          </LinkButton>
        </Tooltip>
      )
    : (
        <LinkButton
          href={href}
          onClick={onSelect}
          aria-current={current ? 'page' : undefined}
          className={cn('group flex w-full items-center gap-3 rounded-2xl px-3 py-3 pr-4 text-left text-base hover:bg-kumo-fill', current && 'bg-kumo-fill')}
        >
          <Slot />
          <span className="min-w-0 flex-1 leading-snug">
            <span className={cn('block truncate font-medium group-hover:text-kumo-default', current ? 'text-kumo-default' : 'text-kumo-subtle')}>New workspace</span>
            <span className="block truncate text-sm text-kumo-subtle">{SUBTITLE}</span>
          </span>
        </LinkButton>
      )
