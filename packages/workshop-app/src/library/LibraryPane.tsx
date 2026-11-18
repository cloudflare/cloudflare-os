import { useState } from 'react'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { DeleteGadgetDialog } from '@/blocks/DeleteGadgetDialog'
import { useGadgetChanges } from '@/gadgets/useGadgetChanges'
import { gadgetKey } from '@/gadgets/WaitingAsks'
import { useRefreshedWaitingAsks, useWaitingAsks } from '@/gadgets/WaitingAsksProvider'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@/hooks/useListView'
import { readLibraryStars, writeLibraryStars } from '@/prefs/libraryStars'
import { useOwnAvatar } from '@/settings/useOwnAvatar'
import { ShareWorkspaceDialog } from '@/workspaces/ShareWorkspaceDialog'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { mayChange, NO_EDITS, withDeletion, withEdits, withoutRename, withRename } from './libraryEdits'
import { libraryList, outputKey, outputTitle } from './libraryList'
import { withStar } from './libraryStars'
import { ALL_TAB, LibraryView, STARRED_TAB } from './LibraryView'
import { useLibrary } from './useLibrary'
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
// How old what the gadgets ask may be when the page is come to before it is read again.
const WAITING_MAX_AGE = 60_000

/**
 * The Library page (`LibraryView`) over what it shows: everything made in the user's workspaces
 * and those shared with them, the formats the deployment offers, the stars, which are this
 * device's, and how the list is looked at. What is renamed or deleted from an output's more menu
 * shows at once, a rename put back if it is refused, and a deleted one leaves the list, and its
 * star with it, once it is gone (`libraryEdits`).
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
  const changes = useGadgetChanges()
  const connection = useConnectionNotice()
  // What each asks of the user, read again as the page is come to.
  useRefreshedWaitingAsks(WAITING_MAX_AGE)
  const waiting = useWaitingAsks()
  const workspaces = useWorkspaces()
  const [edits, setEdits] = useState(NO_EDITS)
  // Why the last rename was not made.
  const [problem, setProblem] = useState<string>()
  // The one being asked about or shared, kept as the dialog closes so that it does not change as it goes.
  const [deleting, setDeleting] = useState<{ output: OutputSummary; open: boolean }>()
  const [sharing, setSharing] = useState<{ output: OutputSummary; open: boolean }>()

  const library = read.status === 'ready' ? { ...read, outputs: withEdits(read.outputs, edits) } : read
  const all = library.status === 'ready' ? library.outputs : []
  // As read, which a rename is made over.
  const asRead = new Map((read.status === 'ready' ? read.outputs : []).map((output) => [outputKey(output), output]))
  const looks = useWorkspaceLooks()
  const { user } = useApi()
  const avatarUrl = useOwnAvatar()
  const list = useListView('library', libraryList(all, offers.map(({ output }) => output), new Set(stars), looks))
  const changeStars = (next: string[]) => {
    setStars(next)
    writeLibraryStars(next)
  }

  const rename = (output: OutputSummary, title: string) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    const was = asRead.get(outputKey(output)) ?? output
    setEdits((current) => withRename(current, was, title))
    changes.rename(output, title).catch((error: unknown) => {
      setEdits((current) => withoutRename(current, was))
      setProblem(`Couldn’t rename “${outputTitle(was)}”: ${messageOf(error)}`)
    })
  }
  const confirmDelete = async () => {
    if (!deleting || connection?.blocked()) return
    const { output } = deleting
    await changes.remove(output)
    setEdits((current) => withDeletion(current, output))
    if (stars.includes(outputKey(output))) changeStars(withStar(stars, outputKey(output), false))
    setDeleting({ ...deleting, open: false })
  }
  // Only what the viewer may do; the server checks again.
  const actionsOf = (output: OutputSummary) => {
    const listed = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === output.workspaceId) : undefined
    if (!mayChange(output, listed)) return undefined
    return {
      onRename: (title: string) => rename(output, title),
      // Shared from its own page, which is what its link lets anyone in to.
      onShare: outputHref && (() => setSharing({ output, open: true })),
      onOpenSettings: onOpenSettings && (() => onOpenSettings(output)),
      onDelete: () => setDeleting({ output, open: true }),
    }
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
      {deleting && (
        <DeleteGadgetDialog
          key={outputKey(deleting.output)}
          open={deleting.open}
          onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
          title={outputTitle(deleting.output)}
          workspace={deleting.output.workspaceTitle || undefined}
          onConfirm={confirmDelete}
        />
      )}
      {sharing && outputHref && (
        <ShareWorkspaceDialog
          key={outputKey(sharing.output)}
          workspaceId={sharing.output.workspaceId}
          title={sharing.output.workspaceTitle || 'Workspace'}
          page={new URL(outputHref(sharing.output), window.location.href).href}
          gadget={{ id: sharing.output.workpieceId, title: outputTitle(sharing.output) }}
          open={sharing.open}
          onOpenChange={(open) => setSharing((current) => current && { ...current, open })}
        />
      )}
    </>
  )
}
