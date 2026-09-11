import { useEffect, useRef, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  AuthenticatedApi,
  GadgetMetadata,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { reportIssue } from './errorReporting'
import { linkActionLog } from './useActions'
import { useDocumentTitle } from './useDocumentTitle'
import {
  beginRetainedShareKeyWrite,
  clearRetainedShareKey,
  commitRetainedShareKeyWrite,
  readRetainedShareKey,
  subscribeToRetainedShareKeyClears,
} from './retainedShareKeys'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from './components/WorkspaceOpenErrorPage'

const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'

export type WorkspaceLoadError =
  | { kind: 'open'; failure: WorkspaceOpenFailureKind }
  | { kind: 'message'; message: string }

type ObserverConfigState = {
  needs: ObserverBindingNeed[]
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: unknown) => void
}

type Options = {
  id: string | undefined
  authenticatedApi: RpcStub<AuthenticatedApi>
  onMetadata: (metadata: GadgetMetadata) => void
  onShareKeyConsumed: () => void
  onInvalidShareKey: () => void
}

export function useWorkspaceOpen({
  id,
  authenticatedApi,
  onMetadata,
  onShareKeyConsumed,
  onInvalidShareKey,
}: Options) {
  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  const [error, setError] = useState<WorkspaceLoadError | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [observerConfig, setObserverConfig] = useState<ObserverConfigState | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const openWorkspaceIdRef = useRef<string | undefined>(undefined)
  // The share key from the URL fragment, retained after the fragment is stripped. A first open can
  // fail before the server redeems the key (nothing persisted; a retry must re-send it) or after
  // (the edge exists; a keyless retry would do). The client cannot tell the two apart, so
  // retention is never cleared on failure (replaying a key whose edge exists is a server-side
  // no-op) and always cleared at the first successful open, since from then on a kept key could
  // only re-redeem the still-active link after an owner removal.
  //
  // Two tiers: this in-memory ref, and a sessionStorage entry that survives a reload
  // (retainedShareKeys.ts). The entry is stamped with the capturing session's userId and honored
  // only by a matching identity, so a key never crosses users in a shared tab. The ref is bound to
  // the `authenticatedApi` stub that captured it and replayed only on that stub, which keeps the
  // common same-stub retry pipelined (no whoami round trip); a stub swap (reconnect or user
  // switch) falls back to the identity-checked storage read. Residuals: a reload before the async
  // stamp lands loses retention (re-click the link); a duplicated tab copies the storage entry,
  // bounded by that module's TTL and cross-tab clear broadcast, which this ref honors too. The
  // secret never enters the URL, history, or error reports; sessionStorage is same-origin,
  // per-tab, and dies with the tab, and gadget UIs run in opaque-origin frames that cannot read it.
  const retainedShareKeyRef = useRef<
      { id: string; key: string; captureId: string; api: RpcStub<AuthenticatedApi> } | null>(null)
  const pendingObserverRejectRef = useRef<((error: unknown) => void) | null>(null)
  const callbacksRef = useRef({ onMetadata, onShareKeyConsumed, onInvalidShareKey })
  callbacksRef.current = { onMetadata, onShareKeyConsumed, onInvalidShareKey }

  useDocumentTitle(error ? '' : metadata?.title)

  // The in-memory tier honors clears like the storage tier does. Local clears are redundant (the
  // attempt nulls the ref itself), but this is the only way a sibling tab's clear reaches this
  // tab's memory: a duplicated tab re-arms its ref from the copied entry (same capture id) and
  // would otherwise keep replaying the spent key on same-stub retries after the original's success
  // swept the storage copy. Scoped by capture id, so a newer local capture is untouched.
  useEffect(() => subscribeToRetainedShareKeyClears(clear => {
    const retained = retainedShareKeyRef.current
    if (!retained) return
    if (clear.scope === 'all' ||
        (retained.id === clear.workspaceId && retained.captureId === clear.captureId)) {
      retainedShareKeyRef.current = null
    }
  }), [])

  useEffect(() => {
    let overseerStub: RpcStub<Overseer> | null = null
    let metadataSubscription: RpcStub<{}> | null = null
    let configureObservers: RpcStub<ObserverConfigCallback> | null = null
    let cancelled = false
    const hadOpenWorkspace = id !== undefined && openWorkspaceIdRef.current === id

    const disposeAttempt = () => {
      metadataSubscription?.[Symbol.dispose]()
      overseerStub?.[Symbol.dispose]()
      configureObservers?.[Symbol.dispose]()
      metadataSubscription = null
      overseerStub = null
      configureObservers = null
    }

    const showTerminalError = (nextError: WorkspaceLoadError) => {
      disposeAttempt()
      openWorkspaceIdRef.current = undefined
      setOverseer(null)
      setMetadata(null)
      setConnectionLost(false)
      setError(nextError)
    }

    const load = async () => {
      if (!id) {
        showTerminalError({ kind: 'open', failure: 'not-found' })
        return
      }
      if (!hadOpenWorkspace) setError(null)

      try {
        const hash = window.location.hash
        let shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        // The capture that owns whatever retention this attempt replays or discards. Clears scope
        // by capture rather than by key so a success can never erase a newer capture's retention,
        // not even a same-key one (the same link clicked again by the tab's next user).
        let shareKeyCaptureId: string | undefined
        // A stored entry this attempt read but could neither attach nor judge (identity unknown),
        // remembered so a keyless success can still discard it after cancellation.
        let unjudgedCaptureId: string | undefined
        if (shareKey) {
          const captureId = crypto.randomUUID()
          shareKeyCaptureId = captureId
          retainedShareKeyRef.current = { id, key: shareKey, captureId, api: authenticatedApi }
          // Stamp the storage tier with the capturing session's identity, resolved from the same
          // stub the open is issued on (useAuth state can be stale across stub swaps). Async so
          // the open stays pipelined; not gated on `cancelled`, since a capture cancelled by a
          // remount must still leave the entry for a later reload. The write token keeps a late
          // stamp from resurrecting an entry a success or logout has since cleared.
          const capturedKey = shareKey
          const write = beginRetainedShareKeyWrite(id, captureId)
          authenticatedApi.whoami().then(info => {
            if (info.type === 'user') {
              commitRetainedShareKeyWrite(write, { key: capturedKey, userId: info.id, captureId })
            }
          }).catch(() => {})
          callbacksRef.current.onShareKeyConsumed()
        } else if (retainedShareKeyRef.current?.id === id &&
                   retainedShareKeyRef.current.api === authenticatedApi) {
          shareKey = retainedShareKeyRef.current.key
          shareKeyCaptureId = retainedShareKeyRef.current.captureId
        } else {
          // A ref captured on a different stub may belong to a different user: drop it and let
          // the identity-checked storage read decide.
          if (retainedShareKeyRef.current?.id === id) retainedShareKeyRef.current = null
          // A reload lost the ref; the storage tier keeps a failed first open retryable across
          // it. Rare path, so the identity round trip does not cost the common keyless open its
          // pipelining.
          const retained = readRetainedShareKey(id)
          if (retained) {
            try {
              const info = await authenticatedApi.whoami()
              // A cancelled attempt no longer owns retention: it must neither re-arm the ref over
              // a newer capture nor judge an entry replaced while it was parked.
              if (cancelled) return
              if (readRetainedShareKey(id)?.captureId !== retained.captureId) {
                // Swept while parked (a sibling's broadcast, a logout sweep, the TTL): the read is
                // stale, so neither attach nor judge it. The open proceeds keylessly.
              } else if (info.type === 'user' && info.id === retained.userId) {
                shareKey = retained.key
                shareKeyCaptureId = retained.captureId
                // Adopt the entry's capture id: this continues the interrupted capture.
                retainedShareKeyRef.current =
                    { id, key: retained.key, captureId: retained.captureId, api: authenticatedApi }
              } else {
                // Someone else's key (a same-tab user switch): sweep rather than redeem it under
                // the wrong account. Scoped to the capture read here so a newer capture's entry
                // and in-flight stamp survive.
                clearRetainedShareKey(id, retained.captureId)
              }
            } catch {
              // Identity unknown: neither attach the key nor discard an entry that may be this
              // user's. The open proceeds keylessly. This is the only branch that leaves a
              // readable entry unjudged, so remember which capture it was.
              unjudgedCaptureId = retained.captureId
            }
          }
        }

        // The identity await may have parked across this attempt's cancellation, whose cleanup ran
        // while overseerStub was still null. Bail before minting a capability that cleanup can
        // never reach and that would be published over the current attempt's state.
        if (cancelled) return

        const configureObserversTarget = new (class extends RpcTarget implements ObserverConfigCallback {
          configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
            if (cancelled) return Promise.reject(new Error('Cancelled'))
            return new Promise<ObserverAccountChoice[]>((resolve, reject) => {
              pendingObserverRejectRef.current = reject
              setObserverConfig({
                needs,
                resolve: choices => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  resolve(choices)
                },
                reject: observerError => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  reject(observerError)
                },
              })
            })
          }
        })()
        configureObservers = new RpcStub(configureObserversTarget)

        overseerStub = authenticatedApi.openGadget(id, shareKey, configureObservers)
        linkActionLog(overseerStub, id)
        setOverseer({ stub: overseerStub })

        if (shareKey !== undefined && shareKeyCaptureId !== undefined) {
          // The server redeems the key inside open(), so once this resolves the key's job is done
          // and a retained copy could only re-redeem the still-live link after an owner removal.
          // Await the open (one extra round trip, keyed opens only) so retention is discarded as
          // soon as success is knowable, rather than after subscribeToMetadata, whose own failures
          // say nothing about the redemption. A rejection reaches the catch with retention kept:
          // the failure may have preceded the redemption, and if not, the replay is a no-op. A
          // response lost in transit leaves the key retained; that residue is irreducible.
          await overseerStub
          // Reaching here proves the redemption is durable, even if this attempt was superseded
          // across the await, so clear exactly this attempt's retention before bailing. A newer
          // attempt may meanwhile have captured its own key (possibly the same key under another
          // user) into this ref and entry; the capture-id checks here and in clearRetainedShareKey
          // leave it alone, stamp and all. The cleanup already disposed the stub, which was
          // assigned before the await.
          if (retainedShareKeyRef.current?.id === id &&
              retainedShareKeyRef.current.captureId === shareKeyCaptureId) {
            retainedShareKeyRef.current = null
          }
          clearRetainedShareKey(id, shareKeyCaptureId)
          if (cancelled) return
        }

        const resolvedSubscription = await overseerStub.subscribeToMetadata((nextMetadata) => {
          if (cancelled) return
          setMetadata(nextMetadata)
          callbacksRef.current.onMetadata(nextMetadata)
        })
        if (cancelled) {
          resolvedSubscription[Symbol.dispose]()
          // Mirror of the keyed path's confirm-after-cancel clear: the subscribe resolving proves
          // the keyless open succeeded, so the entry this attempt could not judge is spent. Scoped
          // to the capture read above, never a fresh read of the slot, so a newer attempt's entry
          // and in-flight stamp survive (a workspace-scoped clear would void the stamp). The ref
          // is already null for this id on this path.
          if (unjudgedCaptureId !== undefined) clearRetainedShareKey(id, unjudgedCaptureId)
          return
        }
        metadataSubscription = resolvedSubscription

        openWorkspaceIdRef.current = id
        // A keyed open already discarded retention above. This covers the keyless corner where a
        // retained entry existed but was not attached (the identity-unknown path): the keyless
        // success proves the key is spent, and a kept one would re-redeem the still-active link
        // when an owner removal's forced reconnect re-runs this effect. Any entry still stored can
        // only be that unjudged one (a newer local capture would have cancelled this attempt), so
        // clear it by capture id first, the scope that is broadcast and so reaches a duplicated
        // tab's copy and, if live, its in-memory ref; then run the workspace-scoped clear, which
        // voids any still-in-flight stamp for the workspace. The ref guard is nominally redundant
        // (every path here already dropped any ref for `id`) and exists so this success never
        // touches another workspace's retention.
        if (retainedShareKeyRef.current?.id === id) retainedShareKeyRef.current = null
        const leftover = readRetainedShareKey(id)
        if (leftover) clearRetainedShareKey(id, leftover.captureId)
        clearRetainedShareKey(id)
        setError(null)
        if (connectionLost) setConnectionLost(false)
      } catch (caught) {
        if (cancelled) return
        console.error('Failed to load gadget:', caught)

        // TODO: Give share-link and observer failures stable codes so this remaining legacy
        // message classification can be removed.
        const message = caught instanceof Error ? caught.message : ''
        if (message.includes('Invalid or expired share key')) {
          callbacksRef.current.onInvalidShareKey()
        }
        if (message.includes(OBSERVER_CANCELLED)) {
          showTerminalError({
            kind: 'message',
            message: 'To open this workspace, you must choose connected accounts for the services it uses.',
          })
        } else if (message.includes('permitted to observe') ||
                   message.includes('no longer connected') ||
                   message.includes('connect an account for every service') ||
                   message.includes('while your access was being verified')) {
          showTerminalError({ kind: 'message', message })
        } else {
          const failure = classifyWorkspaceOpenFailure(caught)
          if (failure !== 'unexpected') {
            showTerminalError({ kind: 'open', failure })
          } else if (!hadOpenWorkspace) {
            reportIssue('gadget.load', caught, { gadgetId: id })
            showTerminalError({ kind: 'open', failure })
          } else if (!connectionLost) {
            setConnectionLost(true)
          }
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      if (pendingObserverRejectRef.current) {
        pendingObserverRejectRef.current(new Error('Cancelled'))
        pendingObserverRejectRef.current = null
      }
      setObserverConfig(null)
      disposeAttempt()
    }
  }, [id, authenticatedApi, reloadNonce])

  return {
    overseer,
    metadata,
    error,
    connectionLost,
    observerConfig,
    retry() {
      setError(null)
      setReloadNonce(value => value + 1)
    },
    cancelObserverConfig() {
      observerConfig?.reject(new Error(OBSERVER_CANCELLED))
    },
    updateTitle(title: string) {
      setMetadata(previous => previous ? { ...previous, title } : null)
    },
  }
}
