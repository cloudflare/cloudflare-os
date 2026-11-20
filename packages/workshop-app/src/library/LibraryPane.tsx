import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { gadgetAsks } from '@/workspaces/WorkspaceSummaries'
import { useWorkspaceSummaries } from '@/workspaces/WorkspaceSummariesContext'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useListView } from '@gadgets/ui'
import { useLibrary } from './OutputsFeedContext'
import { usePreferences, usePreferencesSnapshot } from '@/prefs/UserPreferencesContext'
import { useOwnAvatar } from '@/settings/useOwnAvatar'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { withEdits } from './libraryEdits'
import { libraryList, outputKey } from './libraryList'
import { keepStars, withStar } from './libraryStars'
import { ALL_TAB, LibraryView, RECENT_TAB } from './LibraryView'
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

/**
 * The Library page (`LibraryView`) over what it shows: everything made in the user's workspaces
 * and those shared with them, the formats the deployment offers, the user's stars and what they
 * opened last, which their preferences keep, and how the list is looked at. What is renamed or
 * deleted from an output's more menu shows at once, a rename put back if it is refused, and a
 * deleted one leaves the list, and its star with it, once it is gone (`useLibraryActions`).
 */
export const LibraryPane = ({ tab, onTabChange, onOpenOutput, outputHref, onOpenWorkspace, workspaceHref, onNew, onExplore, onOpenSettings }: LibraryPaneProps) => {
  const read = useLibrary()
  const preferences = usePreferences()
  const { starredOutputs, openedOutputs } = usePreferencesSnapshot()
  const stars = starredOutputs.map(outputKey)
  const opened = openedOutputs.map(outputKey)
  const connection = useConnectionNotice()
  const offers = useOutputFormats()
  // Recent, for whoever has opened anything, and everything otherwise. What waits on the user is
  // first on either.
  const startsAt = opened.length > 0 ? RECENT_TAB : ALL_TAB
  useDocumentTitle('Library')
  // What each asks of the user, as its workspace says.
  const summaries = useWorkspaceSummaries()
  const { edits, actionsOf, problem, dialogs } = useLibraryActions({
    read: read.status === 'ready' ? read.outputs : [],
    outputHref,
    onOpenSettings,
    // Its star goes with it.
    onDeleted: (output) => {
      const key = outputKey(output)
      const current = preferences.getSnapshot().starredOutputs.map(outputKey)
      if (current.includes(key)) keepStars(preferences, withStar(current, key, false))
    },
  })
  const library = read.status === 'ready' ? { ...read, outputs: withEdits(read.outputs, edits) } : read
  const all = library.status === 'ready' ? library.outputs : []
  const looks = useWorkspaceLooks()
  const { user } = useApi()
  const avatarUrl = useOwnAvatar()
  const list = useListView('library', libraryList(all, offers.map(({ output }) => output), new Set(stars), looks))
  const changeStars = (next: string[]) => {
    if (!connection?.blocked()) keepStars(preferences, next)
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
        opened={opened}
        onOpenOutput={onOpenOutput}
        outputHref={outputHref}
        onOpenWorkspace={onOpenWorkspace}
        workspaceHref={workspaceHref}
        onNew={onNew}
        onExplore={onExplore}
        looks={looks}
        me={{ name: user.name, avatarUrl }}
        actionsOf={actionsOf}
        waitingOf={(output) => gadgetAsks(summaries, output.workspaceId, output.workpieceId)}
        problem={problem}
      />
      {dialogs}
    </>
  )
}
