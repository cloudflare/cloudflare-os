import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import type { AppPageOrigin } from '../gadget-page/appPageOrigin'
import type { BlueprintOutput, GadgetClient } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import GadgetUI from '../../GadgetUI'
import ObserverConfigModal from '../../ObserverConfigModal'
import { observerOpenFailureMessage, useWorkspaceOpen } from '../../useWorkspaceOpen'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import { MENU_CONTENT, MENU_ITEM } from '../../components/menuStyles'
import GadgetExportMenu from '../../GadgetExportMenu'
import { logRpcFailure } from '../../rpcErrors'
import { GadgetShareModal } from '../sharing/GadgetShareModal'
import { PaneHeader } from '../chat-page/ChatPageChrome'

/** The app a preview pane shows. */
export type PreviewApp = {
  workspaceId: string
  workpieceId: number
  title: string
  output?: BlueprintOutput
  /** The page showing the preview, which the gadget opened on its own returns to. */
  from?: AppPageOrigin
  /** Told of a rename made from the pane's pill, so the list showing it can follow. */
  onRenamed?: (title: string) => void
}

const noop = () => {}

/**
 * An app opened beside a list, live, as a file opens beside one (Figma "MacBook Pro 14\" - 9"):
 * its glyph and name in the pane's pill, and the app itself on the pane. Opening it full screen,
 * or with its chat, is a step further, from the pane's buttons.
 */
export function AppPreviewPane({ app, onClose, expanded, onExpandedChange }: {
  app: PreviewApp
  onClose: () => void
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}) {
  const navigate = useNavigate()
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const { overseer, metadata, error, observerConfig, createObserverConfigCallback, cancelObserverConfig } =
    useWorkspaceOpen({
      id: app.workspaceId, authenticatedApi,
      onMetadata: noop, onShareKeyConsumed: noop, onInvalidShareKey: noop, namesTab: false,
    })
  // Wrapped, since state can't hold a bare stub (see AGENTS.md).
  const [gadget, setGadget] = useState<{ stub: RpcStub<GadgetClient> } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const useOnly = metadata?.role === 'use'
  const metadataLoaded = metadata !== null

  // As the workspace page does: a builder was verified as the workspace opened, so the app's
  // client pipelines at once; someone who can only use apps is verified as each opens.
  useEffect(() => {
    setGadget(null)
    setFailure(null)
    if (!overseer || !metadataLoaded) return
    if (!useOnly) {
      const stub = overseer.stub.getGadget(app.workpieceId)
      setGadget({ stub })
      return () => stub[Symbol.dispose]()
    }
    const abort = new AbortController()
    const configureObservers = createObserverConfigCallback(abort.signal)
    const admission = overseer.stub.getGadget(app.workpieceId, configureObservers)
    let stub: RpcStub<GadgetClient> | null = null
    admission.then(
      opened => {
        if (!abort.signal.aborted) {
          stub = opened.dup()
          setGadget({ stub })
        }
        opened[Symbol.dispose]()
      },
      caught => {
        if (!abort.signal.aborted) {
          setFailure(observerOpenFailureMessage(caught, 'gadget') ?? 'This gadget couldn’t be opened.')
        }
      },
    )
    return () => {
      abort.abort()
      admission[Symbol.dispose]()
      stub?.[Symbol.dispose]()
      configureObservers[Symbol.dispose]()
    }
  }, [overseer, metadataLoaded, useOnly, app.workpieceId, createObserverConfigCallback])

  const openFullScreen = () => navigate({
    to: '/workspace/$id/app/$appId', params: { id: app.workspaceId, appId: String(app.workpieceId) },
    search: app.from ? { from: app.from } : {},
  })
  const [sharing, setSharing] = useState(false)
  const toasts = useKumoToastManager()

  // A name given from the pill shows at once, for this app only; a failed rename takes it back.
  const appKey = `${app.workspaceId}:${app.workpieceId}`
  const [renamed, setRenamed] = useState<{ key: string; title: string } | null>(null)
  const title = renamed?.key === appKey ? renamed.title : app.title
  const rename = (next: string) => {
    if (!gadget) return
    setRenamed({ key: appKey, title: next })
    gadget.stub.setTitle(next).then(
      () => app.onRenamed?.(next),
      err => {
        logRpcFailure('Failed to rename gadget:', err)
        setRenamed(current => current?.key === appKey && current.title === next ? null : current)
        toasts.add({ title: "Couldn't rename the gadget", variant: 'error' })
      },
    )
  }

  return (
    <>
      <PaneHeader
        glyph={<FormatGlyph output={app.output} size="sm" weight="regular" />}
        title={title}
        onRename={!useOnly && gadget ? rename : undefined}
        menu={<>
          {!useOnly && (
            <DropdownMenu.Item
              onClick={() => navigate({ to: '/workspace/$id', params: { id: app.workspaceId }, search: { w: app.workpieceId } })}
              className={MENU_ITEM}
            >
              Open with chat
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item onClick={openFullScreen} className={MENU_ITEM}>Open on its own</DropdownMenu.Item>
          {/* What the gadget's pane offers in its workspace, so it reads the same here. */}
          {!useOnly && (
            <>
              <DropdownMenu.Separator />
              <GadgetExportMenu
                gadget={gadget?.stub ?? null}
                gadgetTitle={title}
                asSubmenu={{ itemClassName: MENU_ITEM, contentClassName: MENU_CONTENT }}
              />
              <DropdownMenu.Item
                onClick={() => navigate({
                  to: '/workspace/$id/app/$appId/settings',
                  params: { id: app.workspaceId, appId: String(app.workpieceId) },
                  search: app.from ? { from: app.from } : {},
                })}
                className={MENU_ITEM}
              >
                Gadget settings
              </DropdownMenu.Item>
            </>
          )}
        </>}
        onShare={!useOnly && overseer && metadata ? () => setSharing(true) : undefined}
        onExpand={() => onExpandedChange(!expanded)}
        expandLabel={expanded ? 'Exit full screen' : 'Full screen'}
        onClose={onClose}
        closeLabel="Close gadget"
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {error || failure ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
            {failure ?? 'This gadget couldn’t be opened.'}
          </p>
        ) : gadget ? (
          <GadgetUI key={`${app.workspaceId}:${app.workpieceId}`} gadget={gadget.stub} height="100%" isVisible />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="size-6 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        )}
      </div>
      {overseer && metadata && !useOnly && (
        <GadgetShareModal
          open={sharing}
          onClose={() => setSharing(false)}
          overseer={overseer.stub}
          metadata={metadata}
          gadget={{ id: app.workpieceId, title }}
          currentUser={currentUser}
          authenticatedApi={authenticatedApi}
        />
      )}
      {observerConfig && (
        <ObserverConfigModal
          needs={observerConfig.needs}
          authenticatedApi={authenticatedApi}
          onConfirm={observerConfig.resolve}
          onCancel={cancelObserverConfig}
        />
      )}
    </>
  )
}
