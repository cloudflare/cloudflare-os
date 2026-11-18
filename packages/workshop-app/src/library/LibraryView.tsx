import { CirclesFourIcon, CompassIcon, LayoutIcon, PlusIcon } from '@phosphor-icons/react'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { LibraryCard } from '@/blocks/LibraryCard'
import type { LibraryMoreActions } from '@/blocks/LibraryMoreMenu'
import { LibraryRow } from '@/blocks/LibraryRow'
import { ListToolbar } from '@/blocks/ListToolbar'
import { Button } from '@/components/Button'
import { CardGrid } from '@/components/CardGrid'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon } from '@/components/FormatIcon'
import { GroupedList } from '@/components/GroupedList'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import type { ListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { formatActivity } from '@/workspaces/formatActivity'
import type { WorkspaceLooksById } from '@/workspaces/WorkspaceLooks'
import { APP, outputDetail, outputKey, outputTitle, outputWorkspace, type LibraryOrder } from './libraryList'
import { withStar, withStarOrder } from './libraryStars'
import type { LibraryState } from './useLibrary'

/** The tab of the starred, and the tab of everything. The others are a type's id each. */
export const STARRED_TAB = 'starred'
export const ALL_TAB = 'all'

// The filter that leaves the starred out of the other tabs, as the menu has it.
const HIDE_STARRED = 'hide-starred'
const TYPE = 'type:'

const typeOf = (output: OutputSummary) => (output.output ?? APP).id

export type LibraryViewProps = {
  /** The tab that is showing. One there is none of, such as a type nothing is made as, shows everything. */
  tab: string
  onTabChange: (tab: string) => void
  library: LibraryState
  /** How the outputs are listed: the order, the filters and what they are searched for. */
  list: ListView<OutputSummary, LibraryOrder>
  /** The formats something new can be started as by asking for one. */
  formats: BlueprintOutput[]
  /** The keys of the starred outputs, in their order. */
  stars: string[]
  onStarsChange: (stars: string[]) => void
  /** The starred are left out of every tab but their own, where they would otherwise come first. */
  hideStarred: boolean
  onHideStarredChange: (hide: boolean) => void
  onOpenOutput: (output: OutputSummary) => void
  /** An output's page, for its row to link to so that it can be opened in another tab. */
  outputHref?: (output: OutputSummary) => string
  /** Goes to the workspace an output is in, which its card links to. */
  onOpenWorkspace: (output: OutputSummary) => void
  /** That workspace's page, so that it can be opened in another tab. */
  workspaceHref?: (output: OutputSummary) => string
  /** Starts a chat that makes something new: as `format`, when one of those offered was chosen. */
  onNew: (format?: BlueprintOutput) => void
  /** Goes to the templates there are to start something from. */
  onExplore: () => void
  /** How each workspace is drawn, by its id, for a card to show the one it is in. */
  looks?: WorkspaceLooksById
  /** The user, whose picture a card of their own has, as one shared with them has its owner's. */
  me?: { name: string; avatarUrl?: string }
  /**
   * What else can be done to an output from its more menu, besides opening it, which is only what
   * the viewer may: renaming it, sharing it, its settings and deleting it.
   */
  actionsOf?: (output: OutputSummary) => LibraryMoreActions | undefined
  /** How many things an output asks that wait on the user, which its row and card say. */
  waitingOf?: (output: OutputSummary) => number
  /** Why the last thing asked for from a more menu was not done. */
  problem?: string
}

/**
 * The Library page: everything the user's workspaces have made, a tab each for the starred, for
 * all of it, and for each type something has been made as, under the controls a list has. The
 * starred come first in every tab, unless the filter that hides them is on. Its header ends in
 * the way to the templates and the way to start something new.
 */
export const LibraryView = ({
  tab, onTabChange, library, list, formats, stars, onStarsChange, hideStarred, onHideStarredChange, onOpenOutput, outputHref, onOpenWorkspace, workspaceHref, onNew, onExplore, looks, me,
  actionsOf, waitingOf, problem,
}: LibraryViewProps) => {
  const narrow = useNarrowScreen()
  const all = library.status === 'ready' ? library.outputs : []
  const starredKeys = new Set(stars)
  const byKey = new Map(all.map((output) => [outputKey(output), output]))

  // A tab for each type something has been made as, in the order the filters have the types: one
  // for none would only be empty, and one alone would be all there is over again.
  const { filter } = list.controls
  const made = new Set(all.map(typeOf))
  const typeTabs = filter.options
    .filter(({ facet, id }) => facet === 'type' && made.has(id.slice(TYPE.length)))
    .map(({ id, label }) => ({ value: id.slice(TYPE.length), label }))
  const tabs = [{ value: STARRED_TAB, label: 'Starred' }, { value: ALL_TAB, label: 'All' }, ...(typeTabs.length > 1 ? typeTabs : [])]
  const current = tabs.some(({ value }) => value === tab) ? tab : ALL_TAB
  const onStarred = current === STARRED_TAB

  // What the tab has, then what the search and the filters leave of it.
  const inTab = onStarred
    ? stars.flatMap((key) => byKey.get(key) ?? [])
    : current === ALL_TAB ? all : all.filter((output) => typeOf(output) === current)
  const shown = list.narrow(inTab)
  const timeOf = (output: OutputSummary) => formatActivity(list.order.at(output))
  const starredShown = onStarred ? shown : hideStarred ? [] : stars.flatMap((key) => shown.find((output) => outputKey(output) === key) ?? [])
  const groups = [
    ...(starredShown.length > 0 ? [{ key: 'starred', label: 'Starred', entries: starredShown.map((output) => ({ value: output, time: timeOf(output) })) }] : []),
    ...(onStarred ? [] : list.arrange(shown.filter((output) => !starredKeys.has(outputKey(output))))).map(({ key, label, entries }) => ({
      key: `${list.order.id}:${key}`,
      label,
      entries: entries.map(({ value, time }) => ({ value, time: time ?? timeOf(value) })),
    })),
  ]
  // Only with all of the starred there: putting some of them in order would lose the others' places.
  const reorderStarred = list.narrowed || !(onStarred || current === ALL_TAB) ? undefined : (order: string[]) => onStarsChange(withStarOrder(stars, order))

  // What a row and a card are both given.
  const propsOf = (output: OutputSummary) => ({
    title: outputTitle(output),
    icon: output.output?.icon,
    starred: starredKeys.has(outputKey(output)),
    onStarredChange: (on: boolean) => onStarsChange(withStar(stars, outputKey(output), on)),
    href: outputHref?.(output),
    onSelect: () => onOpenOutput(output),
    more: actionsOf?.(output),
    waiting: waitingOf?.(output),
  })

  // The starred and each type have a tab, so the menu has the other filters, and on every tab but
  // the starred's, the one that leaves the starred out.
  const others = filter.options.filter(({ facet, id }) => facet !== 'type' && id !== 'starred')
  const othersOn = filter.value.filter((id) => others.some((option) => option.id === id))
  // Under the list on a narrow screen, in reach of a thumb, and otherwise on the tabs' line, after
  // them, its search a button with the others until it is opened into the room between.
  const toolbar = (
    <ListToolbar
      noun="the library"
      {...list.controls}
      filter={{
        ...filter,
        options: onStarred ? others : [{ id: HIDE_STARRED, label: 'Hide starred' }, ...others],
        value: hideStarred && !onStarred ? [HIDE_STARRED, ...othersOn] : othersOn,
        onChange: (ids) => {
          if (!onStarred) onHideStarredChange(ids.includes(HIDE_STARRED))
          filter.onChange(ids.filter((id) => id !== HIDE_STARRED))
        },
      }}
      at={narrow ? 'bottom' : 'top'}
      inline={!narrow}
    />
  )

  const newItems = (
    <>
      {formats.map((format) => (
        <DropdownMenu.Item key={format.id} label={format.noun} onSelect={() => onNew(format)}>
          <FormatIcon name={format.icon} className="shrink-0" />
          {format.noun}
        </DropdownMenu.Item>
      ))}
      <DropdownMenu.Separator />
      <DropdownMenu.Item icon={LayoutIcon} onSelect={onExplore}>From a template…</DropdownMenu.Item>
    </>
  )
  // Its icon alone on a narrow screen. With no formats to choose between, or until they are known,
  // it starts a chat at once.
  const startNew = formats.length > 0
    ? narrow
      ? <DropdownMenu icon={PlusIcon} aria-label="New" triggerVariant="primary" align="end" inPlace>{newItems}</DropdownMenu>
      : <DropdownMenu label="New" caret triggerVariant="primary" align="end" inPlace>{newItems}</DropdownMenu>
    : narrow
      ? <Button variant="primary" icon={PlusIcon} aria-label="New" title="New" onClick={() => onNew()} />
      : <Button variant="primary" onClick={() => onNew()}>New</Button>

  const note = 'flex flex-wrap items-center justify-center gap-x-3 px-4 text-center text-base text-kumo-subtle'

  return (
    <PageLayout
      footer={narrow ? toolbar : undefined}
      header={(
        <>
          <HeaderBubble>
            <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
              <CirclesFourIcon aria-hidden="true" />
              Library
            </h1>
          </HeaderBubble>
          {/* Apart as a breadcrumb's bubbles are: the header has no gap of its own between them. */}
          <div className="ms-auto flex items-center gap-1.5">
            <HeaderBubble>
              {/* A word of it at least on a narrow screen, where New is its icon alone: a compass by itself says little. */}
              {narrow
                ? <Button icon={CompassIcon} aria-label="Explore templates" onClick={onExplore}>Explore</Button>
                : <Button icon={CompassIcon} onClick={onExplore}>Explore templates</Button>}
            </HeaderBubble>
            <HeaderBubble>{startNew}</HeaderBubble>
          </div>
        </>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col pt-2 pb-8">
        <Tabs value={current} onValueChange={onTabChange} tabs={tabs} aria-label="Library" scrolls align="start" end={narrow ? undefined : toolbar} className="gap-4">
          {/* The one panel, whichever tab it is of: the list is the same one, of what the tab has. */}
          <Tabs.Panel value={current} className="flex flex-col gap-4">
            {problem && <p role="alert" className="px-4 text-center text-base text-kumo-subtle">{problem}</p>}
            {library.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the library…</p>}
            {library.status === 'failed' && (
              <p className={note}>
                Couldn’t load the library: {library.message}
                <Button variant="ghost" onClick={library.retry}>Try again</Button>
              </p>
            )}
            {library.status === 'ready' && all.length === 0 && (
              <p className={note}>
                Nothing yet. What your chats make shows here.
                <Button variant="ghost" onClick={onExplore}>Explore templates</Button>
              </p>
            )}
            {all.length > 0 && inTab.length === 0 && <p className={note}>Nothing starred yet. Star what you want to keep at hand.</p>}
            {inTab.length > 0 && shown.length === 0 && (
              <p className={note}>
                Nothing matches.
                <Button variant="ghost" onClick={list.showAll}>Show all</Button>
              </p>
            )}
            {shown.length > 0 && groups.length === 0 && (
              <p className={note}>
                Everything here is starred.
                <Button variant="ghost" onClick={() => onHideStarredChange(false)}>Show starred</Button>
              </p>
            )}
            {groups.length > 0 && (
              // Another tab, order or view is another list, faded to rather than moved to row by row.
              <div key={`${current}:${list.mode}:${list.order.id}`} className="appears">
                {list.mode === 'list'
                  ? (
                      <GroupedList
                        groups={groups.map(({ key, label, entries }) => ({
                          key,
                          label,
                          rows: entries.map(({ value, time }) => ({ key: outputKey(value), content: <LibraryRow {...propsOf(value)} detail={outputDetail(value)} time={time} /> })),
                          onReorder: key === 'starred' ? reorderStarred : undefined,
                        }))}
                      />
                    )
                  : (
                      <CardGrid
                        large
                        groups={groups.map(({ key, label, entries }) => ({
                          key,
                          label,
                          // The tab's own name over again.
                          labelHidden: onStarred,
                          cards: entries.map(({ value, time }) => ({ key: outputKey(value), content: <LibraryCard {...propsOf(value)} kind={(value.output ?? APP).noun} workspace={{ ...outputWorkspace(value, looks), href: workspaceHref?.(value), onSelect: () => onOpenWorkspace(value) }} owner={value.owner ?? (me && { ...me, you: true })} time={time} /> })),
                          onReorder: key === 'starred' ? reorderStarred : undefined,
                        }))}
                      />
                    )}
              </div>
            )}
          </Tabs.Panel>
        </Tabs>
      </div>
    </PageLayout>
  )
}
