import { LightningIcon } from '@phosphor-icons/react'
import { AutomationRow, type AutomationRowProps } from '@/blocks/AutomationRow'
import { AutomationsEmpty, type AutomationExample } from '@/blocks/AutomationsEmpty'
import { ListGroup } from '@/blocks/ListGroup'
import { ListToolbar } from '@/blocks/ListToolbar'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import type { ListControls } from '@/components/listView'
import { PageLayout } from '@/layouts/PageLayout'

/** Things to ask for in a chat that would make an automation, for the page with none. */
export const AUTOMATION_EXAMPLES: AutomationExample[] = [
  { kind: 'schedule', prompt: 'Every weekday at 9 AM, summarize what came into my inbox overnight' },
  { kind: 'event', prompt: 'When a new issue is opened in our GitHub repo, label it and suggest who should take it' },
  { kind: 'schedule', prompt: 'Every Friday afternoon, write up what changed in our sales sheet this week' },
]

export type AutomationsViewProps = {
  /** Until the workspaces are listed and the schedules read, there is nothing to say. */
  status: 'loading' | 'ready'
  /** The automations as the order arranges them, after the search and the filters. */
  groups: { key: string; label: string; rows: Array<{ key: string; row: AutomationRowProps }> }[]
  /** How many there are before anything narrows them. */
  total: number
  /** How many workspaces are still to be read, whose automations will join the list. */
  reading: number
  /** The workspaces that could not be read, by title. */
  unreachable: string[]
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
 * workspaces are still being read, it says so under what has come in. With nothing at all, it says
 * what an automation is and offers a few things to ask for in a chat.
 */
export const AutomationsView = ({ status, groups, total, reading, unreachable, controls, onShowAll, onTry, narrow = false }: AutomationsViewProps) => {
  const { search, order, filter } = controls
  const toolbar = <ListToolbar noun="automations" search={search} order={order} filter={filter} at={narrow ? 'bottom' : 'top'} />
  const shown = groups.reduce((sum, { rows }) => sum + rows.length, 0)
  const empty = status === 'ready' && reading === 0 && total === 0

  return (
    <PageLayout
      footer={narrow && !empty ? toolbar : undefined}
      header={(
        <HeaderBubble>
          <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <LightningIcon aria-hidden="true" />
            Automations
          </h1>
        </HeaderBubble>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-8">
        {empty ? (
          <AutomationsEmpty examples={AUTOMATION_EXAMPLES} onTry={onTry} />
        ) : (
          <>
            {!narrow && toolbar}
            {total === 0 && <p role="status" className={`appears-late ${NOTE}`}>Loading automations…</p>}
            {total > 0 && shown === 0 && (
              <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
                No automations match.
                <Button variant="ghost" onClick={onShowAll}>Show all</Button>
              </p>
            )}
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
            {total > 0 && reading > 0 && (
              <p role="status" className={`appears-late ${NOTE}`}>Still reading {reading === 1 ? 'one more workspace' : `${reading} more workspaces`}…</p>
            )}
          </>
        )}
        {unreachable.length > 0 && (
          <p className={NOTE}>Couldn’t reach {new Intl.ListFormat('en').format(unreachable)} just now, so {unreachable.length === 1 ? 'its automations aren’t' : 'their automations aren’t'} listed.</p>
        )}
      </div>
    </PageLayout>
  )
}
