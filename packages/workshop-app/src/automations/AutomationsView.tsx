import { FlashIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { AutomationRow, type AutomationRowProps } from '@/blocks/AutomationRow'
import { AutomationsEmpty, type AutomationExample } from '@/blocks/AutomationsEmpty'
import { HeaderBubble, type ListControls, ListGroup, ListToolbar, NoMatches, PageLayout } from '@gadgets/ui'
import { AUTOMATION_DRAFT } from './startDrafts'

/** Things to ask for in a chat that would make an automation, for the page with none. */
export const AUTOMATION_EXAMPLES: AutomationExample[] = [
  { prompt: 'Every weekday at 9 AM, summarize what came into my inbox overnight' },
  { prompt: 'When a new issue is opened in our GitHub repo, label it and suggest who should take it' },
  { prompt: 'Every Friday afternoon, write up what changed in our sales sheet this week' },
]

export type AutomationsViewProps = {
  /** Until the account has said, there is nothing to say. */
  status: 'loading' | 'ready'
  /** The automations as the order arranges them, after the search and the filters. */
  groups: { key: string; label: string; rows: Array<{ key: string; row: AutomationRowProps }> }[]
  /** How many there are before anything narrows them. */
  total: number
  /** The list's search, order and filters. */
  controls: Pick<ListControls, 'search' | 'order' | 'filter'>
  /** Clears the search and the filters. */
  onShowAll: () => void
  /** Starts a chat with something to ask for written in it (`AutomationsEmpty`). */
  onTry: (prompt: string) => void
  /** The controls go under the list, in reach of a thumb. */
  narrow?: boolean
}

const NOTE = 'px-4 text-base text-pretty text-kumo-subtle'

/**
 * Everything that runs by itself, across the workspaces the user builds in, as the Workspaces and
 * Connections pages list theirs: under the list's controls, in groups by how each stands (what
 * needs seeing to first), by workspace or by name, each row saying which workspace it is in. While
 * older workspaces are still being asked for theirs, it says so under what has come in. With
 * nothing at all, it says what an automation is and offers a few things to ask for in a chat.
 */
export const AutomationsView = ({ status, groups, total, controls, onShowAll, onTry, narrow = false }: AutomationsViewProps) => {
  const { search, order, filter } = controls
  const toolbar = <ListToolbar noun="automations" search={search} order={order} filter={filter} at={narrow ? 'bottom' : 'top'} />
  const shown = groups.reduce((sum, { rows }) => sum + rows.length, 0)
  const empty = status === 'ready' && total === 0

  return (
    <PageLayout
      fill={empty}
      footer={narrow && !empty ? toolbar : undefined}
      header={(
        <HeaderBubble>
          <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <FlashIcon aria-hidden="true" />
            Automations
          </h1>
        </HeaderBubble>
      )}
    >
      <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-8', empty && 'flex-1')}>
        {empty ? (
          <AutomationsEmpty examples={AUTOMATION_EXAMPLES} onTry={onTry} onAdd={() => onTry(AUTOMATION_DRAFT)} />
        ) : (
          <>
            {!narrow && toolbar}
            {total === 0 && <p role="status" className={`appears-late ${NOTE}`}>Loading automations…</p>}
            {total > 0 && shown === 0 && <NoMatches noun="automations" onShowAll={onShowAll} />}
            {shown > 0 && (
              // Another order is another list, cut to rather than moved to row by row.
              <div key={order?.value} className="flex flex-col gap-6">
                {/* Under their names, as a workspace's tab has them: what needs seeing to says so. */}
                {groups.map(({ key, label, rows }) => (
                  <section key={key} className="flex flex-col gap-2">
                    <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
                    <ListGroup label={label}>
                      {rows.map(({ key: rowKey, row }) => <AutomationRow key={rowKey} {...row} />)}
                    </ListGroup>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </PageLayout>
  )
}
