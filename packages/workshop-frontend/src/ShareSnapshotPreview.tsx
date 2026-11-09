import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '@cloudflare/kumo'
import { ArrowsOutSimple } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import type { GadgetSnapshotClient, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'
import GadgetExportMenu from './GadgetExportMenu'
import { WorkshopIconButton } from './components/WorkshopControls'
import { FullscreenExitHint } from './components/FullscreenExitHint'
import { logRpcFailure } from './rpcErrors'
import { GadgetUseTitle } from './GadgetUseTitle'
import { SnapshotRefreshButton } from './SnapshotRefreshButton'

type Props = {
  overseer: RpcStub<Overseer>
  gadgetId: WorkpieceId
  gadgetTitle: string
  // What a recipient's top bar names: the workspace and its owner.
  workspaceTitle: string
  ownerName?: string
  // Whether the preview covers the window, as the editor's full-screen gadget does.
  fullscreen: boolean
  onFullscreenChange: (fullscreen: boolean) => void
}

// The preview renders the gadget at this fraction of its size, in a 16:9 frame, so a layout built
// for a full window reads as itself inside the dialog.
const PREVIEW_SCALE = 0.6

/**
 * What a recipient who can't confirm access opens: a snapshot of the gadget (see
 * Overseer.getGadgetSnapshot), taken when this mounts and discarded when it unmounts, so the
 * share dialog's own lifetime bounds the copy. It is live to use, since writes stay in the copy,
 * and a bar above it, like the recipient's top bar, refreshes, exports and opens it full screen.
 */
export const ShareSnapshotPreview = ({
  overseer, gadgetId, gadgetTitle, workspaceTitle, ownerName, fullscreen, onFullscreenChange,
}: Props) => {
  // A stub is wrapped in an object because useState would call a bare (callable) stub.
  // `refreshedAt` is set by a refresh, which breaks the old copy's connections, to reconnect.
  const [snapshot, setSnapshot] = useState<
    { stub: RpcStub<GadgetSnapshotClient>; refreshedAt?: Date } | 'failed' | null
  >(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null)
  const wasFullscreenRef = useRef(fullscreen)
  const ready = snapshot !== null && snapshot !== 'failed' ? snapshot : null

  useEffect(() => {
    let cancelled = false
    let stub: RpcStub<GadgetSnapshotClient> | null = null
    setSnapshot(null)
    const opening = overseer.getGadgetSnapshot(gadgetId)
    opening.then(opened => {
      // Kept through a duplicate, which outlives disposing what the open resolved to.
      if (!cancelled) {
        stub = opened.dup()
        setSnapshot({ stub })
      }
      opened[Symbol.dispose]()
    }, err => {
      if (cancelled) return
      logRpcFailure('Failed to open a gadget snapshot for the share preview:', err)
      setSnapshot('failed')
    })
    return () => {
      cancelled = true
      opening[Symbol.dispose]()
      stub?.[Symbol.dispose]()
    }
  }, [overseer, gadgetId])

  // Escape leaves full screen, as in the editor, but not the dialog too: capturing on window runs
  // ahead of the dialog's own Escape listener. With focus in the iframe, GadgetUI forwards it.
  useEffect(() => {
    if (!fullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onFullscreenChange(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [fullscreen, onFullscreenChange])

  // As in the editor, focus moves into the overlay on entering, off the button it covers, and back
  // to that button on leaving.
  useEffect(() => {
    if (fullscreen) overlayRef.current?.focus()
    else if (wasFullscreenRef.current) fullscreenButtonRef.current?.focus()
    wasFullscreenRef.current = fullscreen
  }, [fullscreen])

  // As a recipient's refresh does (see GadgetEditor's refreshSnapshot).
  const refresh = async () => {
    if (!ready) return
    const refreshedAt = await ready.stub.refresh()
    setSnapshot(current => current === ready ? { ...ready, refreshedAt } : current)
  }

  return (
    <div className="border-b border-kumo-line/70">
      <div className="flex h-12 items-center justify-between gap-3 border-b border-kumo-line/70 pl-3 pr-1.5">
        <GadgetUseTitle workspaceTitle={workspaceTitle} ownerName={ownerName} withLogo={false} />
        {ready && (
          <div className="flex flex-shrink-0 items-center gap-0.5">
            <SnapshotRefreshButton onRefresh={refresh} />
            {/* The recipient's export menu, as it is for a snapshot. */}
            <GadgetExportMenu gadget={ready.stub} gadgetTitle={gadgetTitle} label="Export snapshot" />
            <Tooltip content="Full screen" asChild>
              <WorkshopIconButton
                ref={fullscreenButtonRef}
                aria-label="Enter full screen"
                onClick={() => onFullscreenChange(true)}
              >
                <ArrowsOutSimple size={17} />
              </WorkshopIconButton>
            </Tooltip>
          </div>
        )}
      </div>
      {/* Full screen is the editor's: this element turns into a viewport overlay, so the iframe
          and what was done in it carry over. No `#fullscreen` hash, which the editor would act
          on. The dialog must not be translated meanwhile, or the overlay would cover only the
          dialog (see `dialog-hosts-fullscreen`). */}
      <div
        ref={overlayRef}
        tabIndex={fullscreen ? -1 : undefined}
        role={fullscreen ? 'dialog' : undefined}
        aria-modal={fullscreen ? true : undefined}
        aria-label={fullscreen ? 'Snapshot full screen' : undefined}
        className={fullscreen
          ? 'visual-viewport-fixed z-20 bg-kumo-base outline-none'
          : 'relative aspect-video overflow-hidden bg-kumo-base'}
      >
        {ready ? (
          <div
            className={fullscreen ? 'h-full w-full' : 'absolute left-0 top-0 origin-top-left'}
            style={fullscreen ? undefined : {
              width: `${100 / PREVIEW_SCALE}%`,
              height: `${100 / PREVIEW_SCALE}%`,
              transform: `scale(${PREVIEW_SCALE})`,
            }}
          >
            <GadgetUI
              key={ready.refreshedAt?.getTime()}
              gadget={ready.stub}
              height="100%"
              onIframeEscape={fullscreen ? () => onFullscreenChange(false) : undefined}
            />
          </div>
        ) : (
          <p className="grid h-full place-items-center px-6 text-center text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">
            {snapshot === 'failed' ? 'Couldn’t load a preview.' : 'Taking a snapshot…'}
          </p>
        )}
        {fullscreen && <FullscreenExitHint />}
      </div>
    </div>
  )
}
