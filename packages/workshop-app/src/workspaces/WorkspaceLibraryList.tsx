import { useMemo, useState } from 'react'
import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { ListToolbar } from '@/blocks/ListToolbar'
import { NewFormatMenu } from '@/blocks/NewFormatMenu'
import { Button } from '@/components/Button'
import { useListView } from '@/hooks/useListView'
import { libraryGroups, type LibraryEntry } from '@/library/libraryEntries'
import { LibraryEntryList } from '@/library/LibraryEntryList'
import { libraryList } from '@/library/libraryList'
import { withStarOrder } from '@/library/libraryStars'
import { useLibraryEntries } from '@/library/useLibraryEntries'
import { startableFormats, useOutputFormats } from '@/library/useOutputFormats'
import { readLibraryStarOrder, writeLibraryStarOrder } from '@/prefs/libraryStars'
import { useWorkspaceLooks } from './useWorkspaceLooks'

export type WorkspaceLibraryListProps = {
  workspaceId: string
  onOpen: (entry: LibraryEntry) => void
  /** Where an entry opens, for its row to link to so that it can be opened in another tab. */
  href?: (entry: LibraryEntry) => string
  /**
   * Starts a chat in the workspace that makes something new: as `format`, when one of those offered
   * was chosen. Left out for whoever only uses what is in it.
   */
  onNew?: (format?: BlueprintOutput) => void
}

const latest = (a: LibraryEntry, b: LibraryEntry) => b.at.getTime() - a.at.getTime()

/**
 * What a workspace has made, was sent and worked on, as the Library page lists it, gadgets and
 * files together on the same rows or cards, under the same controls (`ListToolbar`): a search, the
 * view, the order and filters, and New, which starts a chat here as one of the formats offered.
 * What waits on the viewer leads, then the starred, in the order the user put them in, then the
 * rest in the order chosen. It is one workspace's, so it is neither in tabs nor says which
 * workspace each is in.
 */
export const WorkspaceLibraryList = ({ workspaceId, onOpen, href, onNew }: WorkspaceLibraryListProps) => {
  const library = useLibraryEntries(workspaceId)
  const offers = useOutputFormats()
  const [starOrder, setStarOrder] = useState(readLibraryStarOrder)
  const { gadgets, files } = library.entries
  const listed = useMemo(() => [...gadgets, ...files].toSorted(latest), [gadgets, files])
  const list = useListView('workspace-library', libraryList(listed, offers.map(({ output }) => output), useWorkspaceLooks()))
  const groups = libraryGroups(list.narrow(listed), { starOrder, arrange: list.arrange, orderId: list.order.id })

  // Only with all of the starred there: putting some of them in order would lose the others' places.
  const reorderStarred = list.narrowed ? undefined : (order: string[]) => {
    const next = withStarOrder(starOrder, order)
    setStarOrder(next)
    writeLibraryStarOrder(next)
  }

  return (
    <div className="flex flex-col gap-4">
      {listed.length > 0 || onNew
        ? (
            <ListToolbar
              noun="the library"
              {...list.controls}
              at="top"
              // Not the page's main action, which is its New chat.
              action={onNew && <NewFormatMenu formats={startableFormats(offers)} onNew={onNew} primary={false} />}
            />
          )
        : null}
      {library.loading && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the library…</p>}
      {library.problem && (
        <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
          Couldn’t load the library: {library.problem}
          {library.retry && <Button variant="ghost" onClick={library.retry}>Try again</Button>}
        </p>
      )}
      {!library.loading && !library.problem && groups.length === 0 && (
        list.narrowed
          ? (
              <p className="appears flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
                Nothing matches.
                <Button variant="ghost" onClick={list.showAll}>Show all</Button>
              </p>
            )
          : <p className="appears px-4 text-center text-base text-kumo-subtle">Nothing here yet. What this workspace makes shows here.</p>
      )}
      {groups.length > 0 && (
        // Another order or view is another list, faded to rather than moved to row by row.
        <div key={`${list.mode}:${list.order.id}`} className="appears flex flex-col gap-6">
          <LibraryEntryList
            groups={groups}
            view={list.mode}
            headed={false}
            withWorkspace={false}
            onReorderStarred={reorderStarred}
            library={library}
            onOpen={onOpen}
            href={href}
          />
        </div>
      )}
    </div>
  )
}
