import { useState } from 'react'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { gadgetKey } from '@/gadgets/WaitingAsks'
import { useRefreshedWaitingAsks, useWaitingAsks } from '@/gadgets/WaitingAsksProvider'
import { useApi } from '@/rpc/ApiContext'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { readLibraryStars, writeLibraryStars } from '@/prefs/libraryStars'
import { useOwnAvatar } from '@/settings/useOwnAvatar'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { withEdits } from './libraryEdits'
import { libraryList, outputKey } from './libraryList'
import { withStar } from './libraryStars'
import { ALL_TAB, LibraryView, STARRED_TAB } from './LibraryView'
import { useLibrary } from './useLibrary'
import { useLibraryActions } from './useLibraryActions'
import { startableFormats, useOutputFormats } from './useOutputFormats'

export type LibraryPaneProps = {
  /** The tab that is showing; the one the page starts at when none is said. */
  tab?: string
  onTabChange: (tab: string) => void
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
  /** Goes to an output's settings, from its more menu, for whoever builds in its workspace. */
  onOpenSettings?: (output: OutputSummary) => void
}

// How old what the gadgets ask may be when the page is come to before it is read again.
const WAITING_MAX_AGE = 60_000

/**
 * The Library page (`LibraryView`) over what it shows: everything made in the user's workspaces
 * and those shared with them, the formats the deployment offers, the stars, which are this
 * device's, and how the list is looked at. What is renamed or deleted from an output's more menu
 * shows at once, a rename put back if it is refused, and a deleted one leaves the list, and its
 * star with it, once it is gone (`useLibraryActions`).
 */
export const LibraryPane = ({ tab, onTabChange, onOpenOutput, outputHref, onOpenWorkspace, workspaceHref, onNew, onExplore, onOpenSettings }: LibraryPaneProps) => {
  const read = useLibrary()
  const offers = useOutputFormats()
  // The keys of the starred, in their order.
  const [stars, setStars] = useState(readLibraryStars)
  // The starred, for whoever has any, and everything otherwise: as it was when the page was come
  // to, so that starring the first thing does not go to another tab.
  const [startsAt] = useState(() => (stars.length > 0 ? STARRED_TAB : ALL_TAB))
  const [hideStarred, setHideStarred] = useState(false)
  useDocumentTitle('Library')
  // What each asks of the user, read again as the page is come to.
  useRefreshedWaitingAsks(WAITING_MAX_AGE)
  const waiting = useWaitingAsks()
  const { edits, actionsOf, problem, dialogs } = useLibraryActions({
    read: read.status === 'ready' ? read.outputs : [],
    outputHref,
    onOpenSettings,
    // Its star goes with it.
    onDeleted: (output) => {
      if (stars.includes(outputKey(output))) changeStars(withStar(stars, outputKey(output), false))
    },
  })
  const library = read.status === 'ready' ? { ...read, outputs: withEdits(read.outputs, edits) } : read
  const all = library.status === 'ready' ? library.outputs : []
  const looks = useWorkspaceLooks()
  const { user } = useApi()
  const avatarUrl = useOwnAvatar()
  const list = useListView('library', libraryList(all, offers.map(({ output }) => output), new Set(stars), looks))
  const changeStars = (next: string[]) => {
    setStars(next)
    writeLibraryStars(next)
  }

  return (
    <>
      <LibraryView
        tab={tab ?? startsAt}
        onTabChange={onTabChange}
        library={library}
        list={list}
        formats={startableFormats(offers)}
        stars={stars}
        onStarsChange={changeStars}
        hideStarred={hideStarred}
        onHideStarredChange={setHideStarred}
        onOpenOutput={onOpenOutput}
        outputHref={outputHref}
        onOpenWorkspace={onOpenWorkspace}
        workspaceHref={workspaceHref}
        onNew={onNew}
        onExplore={onExplore}
        looks={looks}
        me={{ name: user.name, avatarUrl }}
        actionsOf={actionsOf}
        waitingOf={(output) => waiting.byGadget.get(gadgetKey(output.workspaceId, output.workpieceId)) ?? 0}
        problem={problem}
      />
      {dialogs}
    </>
  )
}
