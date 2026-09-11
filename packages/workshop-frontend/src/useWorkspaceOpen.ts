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
  // The share key from the URL fragment, retained after the fragment is stripped. A first open
  // can fail *before* the server redeems the key (a transport failure, a server throw ahead of
  // the redemption, an attempt superseded before issuing); nothing persisted, so a retry (the
  // retry button, or a reconnection) must re-send the key or it dead-ends on access-denied. A
  // failure *after* redemption leaves a real edge (redemption is one-step server-side), so that
  // retry would resolve keylessly -- but the client cannot tell the two apart, so retention is
  // never cleared on failure; replaying a key whose edge already exists is a server-side no-op.
  // Retention has two tiers: this in-memory ref, and a
  // sessionStorage entry that also survives a reload (see retainedShareKeys.ts). Both are
  // discarded at the *first successful open* -- for a keyed open, the moment openGadget itself
  // resolves (see the post-open clear below): from then on the redeemed edge makes every retry
  // resolvable keylessly, and a kept key would re-redeem the still-active link after an owner
  // removal. The sessionStorage tier is identity-stamped with the
  // capturing session's userId and honored only when the reading session's identity matches, so
  // a key never crosses users in a shared tab (logout additionally sweeps all entries). The
  // in-memory ref carries the `authenticatedApi` stub that captured it and is replayed only on
  // that same stub: a stub swap that kept the same user (a reconnect) re-reads the
  // identity-checked sessionStorage tier instead, and a swap to a different user finds a stamp
  // that doesn't match. Binding to the stub rather than an identity keeps the common same-stub
  // retry pipelined (no whoami round trip), and doesn't rely on the current rendering invariant
  // that an identity change unmounts the editor. Residuals: a reload before the async identity
  // stamp lands loses retention, recovered by re-clicking the invite link; and in the other
  // direction, a *duplicated* tab copies the sessionStorage entry, so a clear here cannot reach
  // the copy directly -- retainedShareKeys.ts bounds that with an entry TTL and a cross-tab
  // clear broadcast, which this ref honors too (see the subscription below), leaving only a
  // duplicate unloaded at broadcast time that reactivates within the TTL able to replay a spent
  // key (see that module's header). The secret never
  // enters the URL or history -- the fragment is stripped before openGadget is even issued --
  // nor error reports (normalizePageLocation keeps origin+pathname only); sessionStorage is
  // same-origin, per-tab, and dies with the tab, and gadget UIs run in opaque-origin frames
  // that cannot read it.
  const retainedShareKeyRef = useRef<
      { id: string; key: string; captureId: string; api: RpcStub<AuthenticatedApi> } | null>(null)
  const pendingObserverRejectRef = useRef<((error: unknown) => void) | null>(null)
  const callbacksRef = useRef({ onMetadata, onShareKeyConsumed, onInvalidShareKey })
  callbacksRef.current = { onMetadata, onShareKeyConsumed, onInvalidShareKey }

  useDocumentTitle(error ? '' : metadata?.title)

  // The in-memory tier honors clears the same way the storage tier does. Local clears are
  // redundant here (the attempt nulls the ref itself before issuing them), but this is the only
  // way a *sibling tab's* clear can reach this tab's memory: a duplicated tab re-arms its ref from
  // the copied storage entry (same capture id as the original's), and when the original's open
  // succeeds and broadcasts, the storage copy is swept while the ref would otherwise keep
  // replaying the spent key on every same-stub retry. Scoped by capture id, so a newer local
  // capture (a different id, even of the same key) is untouched.
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
        // The id of the capture that owns whatever retention this attempt replays or discards.
        // Clears are scoped by capture rather than by key so a success clearing its own retention
        // can never erase a newer capture's -- not even a same-key one (the same invite link
        // clicked again by the tab's next user).
        let shareKeyCaptureId: string | undefined
        // The capture id of a stored entry this attempt read but could neither attach nor judge
        // (identity unknown). Tracked so a keyless success can still discard it after the
        // attempt has been cancelled.
        let unjudgedCaptureId: string | undefined
        if (shareKey) {
          const captureId = crypto.randomUUID()
          shareKeyCaptureId = captureId
          retainedShareKeyRef.current = { id, key: shareKey, captureId, api: authenticatedApi }
          // Stamp the sessionStorage tier with the capturing session's identity, resolved from
          // the same stub the open is issued on (useAuth state can be stale across stub swaps).
          // Async so the open itself stays pipelined; not gated on `cancelled`, since the stamp
          // binds the key to whoever captured it regardless of how this attempt ends (a capture
          // attempt cancelled by a remount must still leave the entry for a later reload). The
          // write token is what keeps a stamp resolving late from resurrecting an entry that a
          // success -- any attempt's, not just this one's -- or logout has since cleared.
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
          // A ref captured on a different stub is not replayed blind -- the stub may belong to a
          // different user. Drop it and let the identity-checked sessionStorage read below decide.
          if (retainedShareKeyRef.current?.id === id) retainedShareKeyRef.current = null
          // A reload lost the in-memory ref; the sessionStorage tier is what keeps a failed
          // first open retryable across it. Rare path, so the identity round trip here does not
          // cost the common keyless open its pipelining.
          const retained = readRetainedShareKey(id)
          if (retained) {
            try {
              const info = await authenticatedApi.whoami()
              // A cancelled attempt resuming here no longer owns retention: it must neither
              // re-arm the in-memory ref over a newer attempt's capture nor judge an entry that
              // may have been replaced while it was parked.
              if (cancelled) return
              if (readRetainedShareKey(id)?.captureId !== retained.captureId) {
                // The entry this attempt read was swept while it was parked -- a sibling tab's
                // clear broadcast after its own open of this capture succeeded, a logout sweep,
                // or the TTL running out. The local read is stale, so neither attach the key it
                // held nor judge it: the open proceeds keylessly, exactly as if the entry had
                // never been there.
              } else if (info.type === 'user' && info.id === retained.userId) {
                shareKey = retained.key
                shareKeyCaptureId = retained.captureId
                // Re-arming adopts the entry's capture id: this attempt continues the capture
                // the reload interrupted rather than starting a new one.
                retainedShareKeyRef.current =
                    { id, key: retained.key, captureId: retained.captureId, api: authenticatedApi }
              } else {
                // Definitely someone else's key (a same-tab user switch): sweep it rather than
                // redeem it under the wrong account. Scoped to the capture this branch actually
                // read and judged, so a newer capture's entry (and its in-flight stamp)
                // survives even if this is ever reached with stale data.
                clearRetainedShareKey(id, retained.captureId)
              }
            } catch {
              // Transport failure: identity unknown, so neither attach the key nor discard an
              // entry that may belong to this user. The open proceeds keylessly. This is the
              // only branch that leaves a readable entry behind unjudged (a mismatch sweeps, a
              // match attaches, a swept-while-parked read stores nothing), so remember which
              // capture it was.
              unjudgedCaptureId = retained.captureId
            }
          }
        }

        // The identity await above may have parked across this attempt's cancellation, and the
        // cleanup that set `cancelled` ran while overseerStub was still null -- it disposed
        // nothing. Bail before creating any capability: past this point a superseded attempt
        // would mint a live server-side stub its own cleanup can never reach and publish it over
        // the current attempt's state (a stale capability, or the wrong workspace's when `id`
        // changed).
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
          // The server redeems the key inside open(), so once this resolves the key's
          // job is done -- and a retained copy could silently re-redeem the still-live link
          // after an owner removal. Await the open (one extra round trip, keyed opens only) so
          // retention is discarded as soon as success is knowable, rather than after
          // subscribeToMetadata below, whose own failure modes (the non-owner whoami round
          // trip, a WS drop) say nothing about the redemption. An open failure rejects here and
          // reaches the same catch as before with retention kept -- correct: the failure may
          // have preceded the redemption (nothing persisted, the key is the only way back), and
          // when it didn't, replaying the key against its existing edge is a no-op. A response
          // lost in transit still leaves the key retained; that residue is irreducible.
          await overseerStub
          // Reaching here proves the server durably redeemed the key -- the edge is written
          // before open() returns, and nothing in disposal unwinds it -- even if this attempt
          // was superseded across the await. So
          // clear exactly this attempt's retention before bailing: a kept spent key would
          // re-redeem the still-live link after an owner removal on every replay path (the
          // in-memory retry, the sessionStorage reload read, the reconnect re-run). A newer
          // attempt may meanwhile have captured its *own* key -- possibly the same key under
          // another user, on a swapped stub -- into the very ref and entry this attempt would
          // clear; the capture-id checks (here and inside clearRetainedShareKey) leave such a
          // newer capture alone, stamp and all. (The stub was assigned before the await, so the
          // cleanup already disposed it.)
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
          // Mirror of the keyed path's confirm-after-cancel clear above: the subscribe resolving
          // proves the keyless open succeeded (the pipelined call would have rejected
          // otherwise), so the entry this attempt read but could not judge is spent, and a
          // cancelled attempt is the only thing left that knows about it. Scoped to the capture
          // this attempt actually read, never to a fresh read of the slot: a newer attempt may
          // have stored its own entry there since, and that one must survive (the
          // capture-scoped clear also leaves its in-flight stamp alone, which the
          // workspace-scoped clear below would void). The ref is already null for this id on
          // this path, so it is left untouched.
          if (unjudgedCaptureId !== undefined) clearRetainedShareKey(id, unjudgedCaptureId)
          return
        }
        metadataSubscription = resolvedSubscription

        openWorkspaceIdRef.current = id
        // A keyed open already discarded retention right after the open resolved above. This
        // repeat clear covers the keyless corner where a retained entry existed but was not
        // attached (the identity-unknown transport-failure path above): the open succeeding
        // keylessly proves the key is no longer needed, and a kept one would silently re-redeem
        // the still-active link after an owner removes this collaborator (the revocation
        // restart reconnects with a new authenticatedApi, re-running this effect while the
        // component stays mounted), undoing the removal. Any entry still stored here can only be
        // that unjudged one, or nothing: a newer local capture would have cancelled this attempt
        // before it got here. So it is cleared by its capture id first -- that scope is what gets
        // broadcast, and a duplicated tab holds a copy of the very same entry (and, if live, the
        // capture in its in-memory ref) that a workspace-scoped clear would leave to replay after
        // the removal. Only duplicates of this tab share the capture id, so the broadcast cannot
        // reach an independent sibling's capture, and a wrongly cleared key costs a re-click of
        // the link. The workspace-scoped clear then still runs: it is what invalidates any
        // still-in-flight identity stamp for the workspace, so a late-resolving capture cannot
        // re-write the entry after this. The cancelled branch just above is the other site that
        // discards the unjudged entry, for an attempt whose success lands after its cleanup.
        retainedShareKeyRef.current = null
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
