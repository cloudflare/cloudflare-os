import { useMemo } from 'react'
import { Button } from '@/components/Button'
import { libraryGroups, type LibraryEntry } from '@/library/libraryEntries'
import { LibraryList } from '@/library/LibraryList'
import { useLibraryEntries } from '@/library/useLibraryEntries'

export type WorkspaceLibraryListProps = {
  workspaceId: string
  onOpen: (entry: LibraryEntry) => void
  /** Where an entry opens, for its row to link to so that it can be opened in another tab. */
  href?: (entry: LibraryEntry) => string
}

/**
 * What a workspace has made, was sent and worked on, as the Library lists it, on the same rows:
 * what is starred first, then latest first, grouped by when.
 */
export const WorkspaceLibraryList = ({ workspaceId, onOpen, href }: WorkspaceLibraryListProps) => {
  const library = useLibraryEntries(workspaceId)
  const groups = useMemo(() => libraryGroups(library.entries, { tab: 'all', sort: 'recent' }), [library.entries])

  return (
    <>
      {library.loading && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the library…</p>}
      {library.problem && (
        <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
          Couldn’t load the library: {library.problem}
          {library.retry && <Button variant="ghost" onClick={library.retry}>Try again</Button>}
        </p>
      )}
      {!library.loading && !library.problem && groups.length === 0 && (
        <p className="px-4 text-center text-base text-kumo-subtle">Nothing here yet. What this workspace makes shows here.</p>
      )}
      {groups.length > 0 && <LibraryList groups={groups} library={library} onOpen={onOpen} href={href} />}
    </>
  )
}
