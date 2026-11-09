import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { DropdownMenu } from '@cloudflare/kumo'
import { useNavigate } from '@tanstack/react-router'
import type { BlueprintOutput, GadgetClient } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import GadgetUI from '../../GadgetUI'
import ObserverConfigModal from '../../ObserverConfigModal'
import { observerOpenFailureMessage, useWorkspaceOpen } from '../../useWorkspaceOpen'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import { MENU_ITEM } from '../../components/menuStyles'
import { GadgetShareModal } from '../sharing/GadgetShareModal'
import { PaneHeader } from '../chat-page/ChatPageChrome'

/** The app a preview pane shows. */
export type PreviewApp = {
  workspaceId: string
  workpieceId: number
  title: string
  output?: BlueprintOutput
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
          setFailure(observerOpenFailureMessage(caught, 'gadget') ?? 'This app couldn’t be opened.')
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
  })
  const [sharing, setSharing] = useState(false)

  return (
    <>
      <PaneHeader
        glyph={<FormatGlyph output={app.output} size="sm" weight="regular" />}
        title={app.title}
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
        </>}
        onShare={!useOnly && overseer && metadata ? () => setSharing(true) : undefined}
        onExpand={() => onExpandedChange(!expanded)}
        expandLabel={expanded ? 'Exit full screen' : 'Full screen'}
        onClose={onClose}
        closeLabel="Close app"
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {error || failure ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-[13px] text-kumo-subtle">
            {failure ?? 'This app couldn’t be opened.'}
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
          gadget={{ id: app.workpieceId, title: app.title }}
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
