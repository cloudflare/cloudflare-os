import { useState } from 'react'
import { CirclesFourIcon } from '@phosphor-icons/react'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { LibraryCard } from '@/blocks/LibraryCard'
import { LibraryRow } from '@/blocks/LibraryRow'
import { ListToolbar } from '@/blocks/ListToolbar'
import { Button } from '@/components/Button'
import { CardGrid } from '@/components/CardGrid'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon } from '@/components/FormatIcon'
import { GroupedList } from '@/components/GroupedList'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { PageLayout } from '@/layouts/PageLayout'
import { readLibraryStars, writeLibraryStars } from '@/prefs/libraryStars'
import { formatActivity } from '@/workspaces/formatActivity'
import { libraryList, outputDetail, outputKey, outputTitle } from './libraryList'
import { withStar, withStarOrder } from './libraryStars'
import { useLibrary } from './useLibrary'
import { startableFormats, useOutputFormats } from './useOutputFormats'

export type LibraryPaneProps = {
  onOpenOutput: (output: OutputSummary) => void
  /** An output's page, for its row to link to so that it can be opened in another tab. */
  outputHref?: (output: OutputSummary) => string
  /** Starts a chat that makes something new: as `format`, when one of those offered was chosen. */
  onNew: (format?: BlueprintOutput) => void
}

/**
 * Everything made in the user's workspaces and those shared with them, each opening as its own
 * page: the starred ones first, in the order the user put them in (the latest starred first until
 * then), then the rest in the order chosen (most recently active first, until another is), grouped
 * as that order groups them. Over them, the list's controls: a search, rows or cards, the order,
 * filters, and the way to start something new, as one of the formats the deployment offers.
 */
export const LibraryPane = ({ onOpenOutput, outputHref, onNew }: LibraryPaneProps) => {
  const library = useLibrary()
  const offers = useOutputFormats()
  // The keys of the starred, in their order.
  const [stars, setStars] = useState(readLibraryStars)
  useDocumentTitle('Library')

  const all = library.status === 'ready' ? library.outputs : []
  const starredKeys = new Set(stars)
  const list = useListView('library', libraryList(all, offers.map(({ output }) => output), starredKeys))
  const shown = list.narrow(all)
  const shownByKey = new Map(shown.map((output) => [outputKey(output), output]))
  const starred = stars.flatMap((key) => shownByKey.get(key) ?? [])
  const timeOf = (output: OutputSummary) => formatActivity(list.order.at(output))
  const groups = [
    ...(starred.length > 0 ? [{ key: 'starred', label: 'Starred', entries: starred.map((output) => ({ value: output, time: timeOf(output) })) }] : []),
    ...list.arrange(shown.filter((output) => !starredKeys.has(outputKey(output)))).map(({ key, label, entries }) => ({
      key: `${list.order.id}:${key}`,
      label,
      entries: entries.map(({ value, time }) => ({ value, time: time ?? timeOf(value) })),
    })),
  ]

  const keepStars = (next: string[]) => {
    setStars(next)
    writeLibraryStars(next)
  }
  // Only with all of the starred there: putting some of them in order would lose the others' places.
  const reorderStarred = list.narrowed ? undefined : (order: string[]) => keepStars(withStarOrder(stars, order))
  // What a row and a card are both given.
  const propsOf = (output: OutputSummary) => ({
    title: outputTitle(output),
    icon: output.output?.icon,
    starred: starredKeys.has(outputKey(output)),
    onStarredChange: (on: boolean) => keepStars(withStar(stars, outputKey(output), on)),
    href: outputHref?.(output),
    onSelect: () => onOpenOutput(output),
  })

  // Under the list on a narrow screen, in reach of a thumb, and over it otherwise.
  const narrow = useNarrowScreen()
  const startable = startableFormats(offers)
  const toolbar = (
    <ListToolbar
      noun="the library"
      {...list.controls}
      at={narrow ? 'bottom' : 'top'}
      action={startable.length > 0
        ? (
            <DropdownMenu label="New" caret triggerVariant="primary" side={narrow ? 'top' : 'bottom'} align="end" inPlace>
              {startable.map((format) => (
                <DropdownMenu.Item key={format.id} label={format.noun} onSelect={() => onNew(format)}>
                  <FormatIcon name={format.icon} className="size-4 shrink-0" />
                  {format.noun}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu>
          )
        // With no formats to choose between, or until they are known, it starts a chat at once.
        : <Button variant="primary" onClick={() => onNew()}>New</Button>}
    />
  )

  return (
    <PageLayout
      footer={narrow ? toolbar : undefined}
      header={(
        <HeaderBubble>
          <h1 className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base pr-(--control-pad) pl-(--control-pad-icon) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line [&>svg]:size-[1.125em]">
            <CirclesFourIcon aria-hidden="true" />
            Library
          </h1>
        </HeaderBubble>
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-8">
        {!narrow && toolbar}
        {library.status === 'loading' && <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading the library…</p>}
        {library.status === 'failed' && (
          <p className="flex items-center gap-3 px-4 text-base text-kumo-subtle">
            Couldn’t load the library: {library.message}
            <Button variant="ghost" onClick={library.retry}>Try again</Button>
          </p>
        )}
        {library.status === 'ready' && all.length === 0 && (
          <p className="px-4 text-center text-base text-kumo-subtle">Nothing yet. What your chats make shows here.</p>
        )}
        {all.length > 0 && shown.length === 0 && (
          <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
            Nothing matches.
            <Button variant="ghost" onClick={list.showAll}>Show all</Button>
          </p>
        )}
        {shown.length > 0 && (
          // Another order or view is another list, faded to rather than moved to row by row.
          <div key={`${list.mode}:${list.order.id}`} className="appears">
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
                    groups={groups.map(({ key, label, entries }) => ({
                      key,
                      label,
                      // A card has no room to say which workspace it is in, which a search still finds it by.
                      cards: entries.map(({ value, time }) => ({ key: outputKey(value), content: <LibraryCard {...propsOf(value)} detail={outputDetail(value, { workspace: false })} time={time} /> })),
                      onReorder: key === 'starred' ? reorderStarred : undefined,
                    }))}
                  />
                )}
          </div>
        )}
      </div>
    </PageLayout>
  )
}
