import { useEffect, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  GadgetMetadata,
  ObserverAccountChoice,
  ObserverConfigCallback,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from '../../../components/WorkspaceOpenErrorPage'
import { logRpcFailure } from '../../../rpcErrors'

/**
 * Why a preview could not be shown: a failure the workspace's open reports, or `needs-setup`
 * when opening it asked the viewer to choose connected accounts, which only the workspace
 * itself offers.
 */
export type WorkspacePreviewFailure = WorkspaceOpenFailureKind | 'needs-setup'

/** Where a preview of a workspace stands. */
export type WorkspacePreviewState =
  | { state: 'loading' }
  | { state: 'ready'; overseer: RpcStub<Overseer>; metadata: GadgetMetadata }
  | { state: 'failed'; failure: WorkspacePreviewFailure }

// Declines every request to choose connected accounts. A preview is a glance from a list, not
// the place to set a workspace up, so the open is left to fail and the viewer is sent to the
// workspace instead. `asked` tells that failure apart from the others.
class DecliningObserverConfig extends RpcTarget implements ObserverConfigCallback {
  asked = false

  configure(): Promise<ObserverAccountChoice[]> {
    this.asked = true
    return Promise.reject(new Error('A preview does not configure connected accounts.'))
  }
}

/**
 * Opens a workspace for a preview, in the viewer's own role and without a share key, and follows
 * its metadata. Unlike the editor's open it leaves the browser tab's title and the URL alone, and
 * never asks the viewer to choose connected accounts (see `WorkspacePreviewFailure`). Everything
 * it opens is disposed when the open fails, when `workspaceId` changes, on `retry`, and on unmount.
 */
export const useWorkspacePreview = (
  workspaceId: string,
): WorkspacePreviewState & { retry: () => void } => {
  const { authenticatedApi } = useAuthenticatedApi()
  // The stub is held inside the state object, never as the state itself: React would call it.
  const [preview, setPreview] = useState<{ workspaceId: string; view: WorkspacePreviewState }>(
    { workspaceId, view: { state: 'loading' } },
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const observerConfig = new DecliningObserverConfig()
    const configureObservers = new RpcStub(observerConfig)
    // Not awaited: the subscription is pipelined on the open, and disposing the promise disposes
    // the workspace it resolves to.
    const overseer: RpcStub<Overseer> = authenticatedApi.openGadget(workspaceId, undefined, configureObservers)
    let subscription: RpcStub<{}> | null = null
    let released = false
    const release = () => {
      if (released) return
      released = true
      subscription?.[Symbol.dispose]()
      overseer[Symbol.dispose]()
      configureObservers[Symbol.dispose]()
    }
    setPreview({ workspaceId, view: { state: 'loading' } })

    overseer.subscribeToMetadata((metadata: GadgetMetadata) => {
      if (!cancelled) setPreview({ workspaceId, view: { state: 'ready', overseer, metadata } })
    })
      .then((resolved) => {
        if (cancelled) resolved[Symbol.dispose]()
        else subscription = resolved
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const failure = observerConfig.asked ? 'needs-setup' : classifyWorkspaceOpenFailure(err)
        if (failure === 'unexpected') logRpcFailure('Failed to open a workspace for its preview:', err)
        setPreview({ workspaceId, view: { state: 'failed', failure } })
        // A failed preview holds nothing open while it waits for a retry or another selection.
        release()
      })

    return () => {
      cancelled = true
      release()
    }
  }, [authenticatedApi, workspaceId, attempt])

  const retry = () => setAttempt(value => value + 1)
  // Until the effect has started on a new id, what is held describes the previous one.
  if (preview.workspaceId !== workspaceId) return { state: 'loading', retry }
  return { ...preview.view, retry }
}
