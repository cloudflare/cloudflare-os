import { useEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import GadgetUI, { type GadgetUiSource } from '../../GadgetUI'
import { useActionEntries, useActions } from '../../useActions'
import { useResolveAction } from '../../useResolveAction'
import type { ConnectionPreview } from './connectionPreview'
// SPIKE: the gatekeeper would supply this code. See the file's header.
import DOCS_PREVIEW_CLIENT from './docsPreviewClient.js?raw'

// Long enough to fold a burst of queued edits into one redraw.
const REFRESH_DEBOUNCE_MS = 300

type ConnectionPreviewPaneProps = {
  overseer: RpcStub<Overseer>
  preview: ConnectionPreview
  /** A restricted workspace reviews in the chat, where the approval notices are. */
  restricted: boolean
}

/**
 * A connection's content in the gadget UI frame, with the connection's session as the frame's
 * `gadget` stub. The frame only reads; applying and discarding are drawn here, outside it.
 */
export const ConnectionPreviewPane = ({ overseer, preview, restricted }: ConnectionPreviewPaneProps) => {
  const { gatekeeperId } = preview

  const [source, setSource] = useState<GadgetUiSource | null>(null)
  useEffect(() => {
    const client = overseer.getGatekeeperById(gatekeeperId)
    setSource({
      getUiBundle: async () => ({ jsCode: DOCS_PREVIEW_CLIENT }),
      connectToGadget: () => client.openSession(),
    })
    return () => {
      setSource(null)
      client[Symbol.dispose]()
    }
  }, [overseer, gatekeeperId])

  const [refreshSignal, setRefreshSignal] = useState(0)
  const refreshTimer = useRef<number | undefined>(undefined)
  const subscribed = useRef(false)
  useActionEntries(overseer, entry => {
    // Subscribing replays entries from before the pane opened, which its first read already shows.
    if (!subscribed.current) return
    // Actions only: the preview's own reads are logged on this connection as observations, so
    // refreshing on those would never stop.
    if (entry.type !== 'action' || entry.gatekeeperId !== gatekeeperId) return
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => setRefreshSignal(n => n + 1), REFRESH_DEBOUNCE_MS)
  })
  // After useActionEntries, so its replay has run by the time this is set.
  useEffect(() => {
    subscribed.current = true
    return () => {
      subscribed.current = false
      window.clearTimeout(refreshTimer.current)
    }
  }, [])

  const { pending } = useActions(overseer)
  const waiting = pending.filter(entry => entry.type === 'action' && entry.gatekeeperId === gatekeeperId)
  // Oldest first, the order the connection applies them in.
  const next = waiting[0]

  const [processing, setProcessing] = useState<Set<number>>(() => new Set())
  const { resolveAction, creationAccountModal } = useResolveAction(overseer, setProcessing)
  const busy = next !== undefined && processing.has(next.id)

  return (
    <div className="relative h-full">
      {source && (
        <GadgetUI gadget={source} height="100%" refreshSignal={refreshSignal} />
      )}
      {next?.type === 'action' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
          <section
            aria-label="Changes waiting"
            className="pointer-events-auto w-full max-w-[600px] rounded-xl border border-kumo-line bg-kumo-base shadow-lg"
          >
            <div className="px-4 pt-3 pb-2">
              <p className="m-0 truncate text-[13px] font-medium leading-5 text-kumo-default">
                {next.description.title}
              </p>
              <p className="m-0 line-clamp-2 text-[12px] leading-[18px] text-kumo-subtle">
                {next.description.description}
              </p>
            </div>
            <div className="flex items-center gap-2 border-t border-kumo-line px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-kumo-subtle" role="status">
                {waiting.length === 1 ? '1 change waiting' : `${waiting.length} changes waiting`}
              </span>
              {restricted ? (
                <span className="text-[12px] text-kumo-subtle">Review in the chat</span>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void resolveAction(next, 'deny')}
                  >
                    Discard
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy}
                    onClick={() => void resolveAction(next, 'approve')}
                  >
                    Apply
                  </Button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {creationAccountModal}
    </div>
  )
}
