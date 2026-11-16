import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { CaretUp } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { entryFields } from '../../components/ActionFields'
import { IncompleteDescriptionNotice, isDescriptionIncomplete } from '../../components/IncompleteDescriptionNotice'
import GadgetUI, { type GadgetUiSource } from '../../GadgetUI'
import { useActions } from '../../useActions'
import { useResolveAction } from '../../useResolveAction'
import { ChangeFields, ChangeProse } from './ChangeDetail'
import { previewOf, type ConnectionPreview } from './connectionPreview'
import { useNewActionEntries } from './useNewActionEntries'

// Long enough to fold a burst of queued edits into one redraw.
const REFRESH_DEBOUNCE_MS = 300

type ConnectionPreviewPaneProps = {
  overseer: RpcStub<Overseer>
  preview: ConnectionPreview
  /** A restricted workspace reviews in the chat, where the approval notices are. */
  restricted: boolean
  /** The connection's resource was created, so the connection now reads that one: the preview of it. */
  onCreated: (preview: ConnectionPreview) => void
}

/**
 * A connection's content in the gadget UI frame, with the connection's session as the frame's
 * `gadget` stub. The frame only reads; applying and discarding are drawn here, outside it.
 */
export const ConnectionPreviewPane = ({ overseer, preview, restricted, onCreated }: ConnectionPreviewPaneProps) => {
  const { gatekeeperId } = preview

  const [source, setSource] = useState<GadgetUiSource | null>(null)
  useEffect(() => {
    const client = overseer.getGatekeeperById(gatekeeperId)
    setSource({
      getUiBundle: () => client.getPreviewUi(),
      connectToGadget: () => client.openSession(),
    })
    return () => {
      setSource(null)
      client[Symbol.dispose]()
    }
  }, [overseer, gatekeeperId])

  const [refreshSignal, setRefreshSignal] = useState(0)
  const refreshTimer = useRef<number | undefined>(undefined)
  // Entries from before the pane opened are skipped: its first read already shows them.
  useNewActionEntries(overseer, entry => {
    // Actions only: the preview's own reads are logged on this connection as observations, so
    // refreshing on those would never stop.
    if (entry.type !== 'action' || entry.gatekeeperId !== gatekeeperId) return
    // Creating the resource restarts its connection on the real one, which ends this pane's
    // session: the pane is opened anew on what was created.
    if (entry.creation && entry.state === 'approved') return onCreated(previewOf(gatekeeperId, entry))
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => setRefreshSignal(n => n + 1), REFRESH_DEBOUNCE_MS)
  })
  useEffect(() => () => window.clearTimeout(refreshTimer.current), [])

  const { pending } = useActions(overseer)
  const waiting = pending.filter(entry => entry.type === 'action' && entry.gatekeeperId === gatekeeperId)
  // Oldest first, the order the connection applies them in.
  const next = waiting[0]
  // The buttons act on the one change the card describes, which its count says when others wait behind it.
  const several = waiting.length > 1

  // The change whose card is opened, so the next one starts closed.
  const [detailed, setDetailed] = useState<number>()
  const open = next !== undefined && detailed === next.id

  const detailId = useId()
  const [processing, setProcessing] = useState<Set<number>>(() => new Set())
  const { resolveAction, creationAccountModal } = useResolveAction(overseer, setProcessing)
  const busy = next !== undefined && processing.has(next.id)

  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {source && (
          <GadgetUI gadget={source} height="100%" refreshSignal={refreshSignal} />
        )}
      </div>
      {next?.type === 'action' && (
        // Over the foot of the frame, which draws the change: closed, the card is two lines and its
        // buttons. Opened, it shows everything the action sends, not only what the frame draws: a
        // comment's text is in no document.
        <section
          aria-label="Changes waiting"
          className="absolute inset-x-4 bottom-4 mx-auto flex max-h-[50%] max-w-[640px] flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base shadow-xl"
        >
          <div id={detailId} className="min-h-0 overflow-y-auto px-4 pt-3.5 pb-3">
            <p className="m-0 truncate text-[13.5px] font-semibold leading-5 tracking-[-0.15px] text-kumo-default">
              {next.description.title}
            </p>
            {open ? next.description.description.split(/\n{2,}/).map((paragraph, n) => (
              <p key={n} className="m-0 mt-1 whitespace-pre-wrap text-[12px] leading-[19px] text-kumo-subtle">
                <ChangeProse text={paragraph} />
              </p>
            )) : (
              <p className="m-0 mt-0.5 truncate text-[12px] leading-[18px] text-kumo-subtle">
                <ChangeProse text={next.description.description} />
              </p>
            )}
            {open && <ChangeFields fields={entryFields(next)} />}
            {isDescriptionIncomplete(next) && <IncompleteDescriptionNotice className="mt-2" />}
          </div>
          <div className="flex items-center gap-2 border-t border-kumo-line/70 bg-kumo-elevated px-4 py-2">
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-kumo-subtle" role="status">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-kumo-brand" aria-hidden="true" />
              <span className="truncate">
                {several ? `1 of ${waiting.length} changes waiting` : '1 change waiting'}
              </span>
            </span>
            <Button
              variant="ghost"
              size="xs"
              aria-expanded={open}
              aria-controls={detailId}
              className="mr-auto"
              icon={<CaretUp size={11} weight="bold" className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />}
              onClick={() => setDetailed(open ? undefined : next.id)}
            >
              {open ? 'Less detail' : 'More detail'}
            </Button>
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
      )}
      {creationAccountModal}
    </div>
  )
}
