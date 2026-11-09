import { useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, AuthenticatedApi, GadgetClient, Overseer, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import GadgetUI from '../../GadgetUI'
import ExploreCard from './ExploreCard'
import ExploreDialog from './ExploreDialog'
import { readCardDismissed, readExploreMemory, writeCardDismissed } from './exploreMemory'
import { useExplore } from './useExplore'
import { ownerFirstName, viewAgeLabel, viewMoment, viewTimestamp } from './viewTime'

/** What the top bar shows for a view: whose it is, when it was taken, and whether the card is away. */
export type SharedViewChrome = {
  ownerName: string
  /** When the view was taken, aged ("today, 10:42"). */
  moment: string
  /** The full timestamp, for the chip's tooltip. */
  timestamp: string
  /** "3 weeks old" once the view is stale. */
  age: string | null
  /** The card was dismissed into the header chip. */
  collapsed: boolean
}

type Props = {
  /** A client whose access mode is "view": its UI and connection are the view's copy of the gadget. */
  gadget: RpcStub<GadgetClient>
  gadgetId: WorkpieceId
  workspaceId: string
  appName: string
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** The explore check passed: reopen the gadget, which now admits the viewer live. */
  onLive: () => void
  onChrome: (chrome: SharedViewChrome | null) => void
  /** Changes when the header chip is clicked; each change brings the card back. */
  expand: number
}

type Loaded = { takenAt: Date; owner: AiChatAuthorInfo }

const MINUTE_MS = 60_000

/**
 * Someone else's view of a gadget: the gadget's own UI, run against the view's copy of it, with a
 * card floating over its top that says whose it is and when, and offers to verify the viewer's access.
 * The copy is the owner's storage with no bindings, so the UI works as it does for the owner
 * except where it reaches for one; when the owner's next open replaces the copy, the UI's
 * connection drops and GadgetUI reconnects to the new one.
 */
const SharedViewPane = ({
  gadget, gadgetId, workspaceId, appName, overseer, authenticatedApi, onLive, onChrome, expand,
}: Props) => {
  const toasts = useKumoToastManager()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [checked, setChecked] = useState(
    () => !!readExploreMemory(workspaceId, gadgetId)?.refusedChoices)
  const [dismissed, setDismissed] = useState(() => readCardDismissed(workspaceId, gadgetId))
  const [now, setNow] = useState(() => new Date())

  const explore = useExplore({
    overseer, authenticatedApi, workspaceId, gadgetId,
    onLive: () => {
      toasts.add({ title: "Access verified. You're using the live gadget." })
      onLive()
    },
    onRefused: () => setChecked(true),
  })

  useEffect(() => {
    let cancelled = false
    const view = gadget.getView()
    view.then(({ takenAt, owner }) => {
      if (!cancelled) setLoaded({ takenAt, owner })
    }).catch(() => {})
    return () => {
      cancelled = true
      view[Symbol.dispose]()
    }
  }, [gadget])

  // "today, 10:42" becomes "yesterday, 10:42" without a reload.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [])

  const ownerName = loaded ? ownerFirstName(loaded.owner) : null
  const moment = loaded ? viewMoment(loaded.takenAt, now) : ''
  const age = loaded ? viewAgeLabel(loaded.takenAt, now) : null
  const timestamp = loaded ? viewTimestamp(loaded.takenAt) : ''
  useEffect(() => {
    onChrome(ownerName ? { ownerName, moment, timestamp, age, collapsed: dismissed } : null)
  }, [ownerName, moment, timestamp, age, dismissed, onChrome])
  useEffect(() => () => onChrome(null), [onChrome])

  const showCard = (show: boolean) => {
    setDismissed(!show)
    writeCardDismissed(workspaceId, gadgetId, !show)
  }
  useEffect(() => {
    if (expand > 0) showCard(true)
    // Only a click on the chip brings the card back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expand])

  const openExplore = () => {
    const memory = readExploreMemory(workspaceId, gadgetId)
    explore.start(checked ? memory?.refusedChoices : undefined)
  }

  return (
    <div className="relative h-full">
      <GadgetUI gadget={gadget} height="100%" isVisible={true} />
      {ownerName && !dismissed && (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3 sm:top-4">
          <div className="pointer-events-auto w-full max-w-[520px]">
            <ExploreCard
              checked={checked}
              ownerName={ownerName}
              moment={moment}
              onOpen={openExplore}
              onDismiss={() => showCard(false)}
            />
          </div>
        </div>
      )}
      {ownerName && (
        <ExploreDialog
          explore={explore}
          authenticatedApi={authenticatedApi}
          ownerName={ownerName}
          appName={appName}
        />
      )}
    </div>
  )
}

export default SharedViewPane
