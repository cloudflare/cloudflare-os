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
import { useDocumentTitle } from './useDocumentTitle'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from './components/WorkspaceOpenErrorPage'

const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'

// The sessionStorage tier of share-key retention (see retainedShareKeyRef). All operations are
// best-effort: storage can be unavailable in restricted browser contexts, and a lost key only
// costs the user a re-visit of their invite link.
const RETAINED_SHARE_KEY_PREFIX = 'gadgets:retained-share-key:v1'

function retainedShareKeyStorageKey(workspaceId: string): string {
  return `${RETAINED_SHARE_KEY_PREFIX}:${workspaceId}`
}

function writeRetainedShareKey(workspaceId: string, key: string): void {
  try {
    window.sessionStorage.setItem(retainedShareKeyStorageKey(workspaceId), key)
  } catch {
    // Best-effort; see above.
  }
}

function readRetainedShareKey(workspaceId: string): string | undefined {
  try {
    const value = window.sessionStorage.getItem(retainedShareKeyStorageKey(workspaceId))
    // Lenient bounds only -- the server is the validator of record for the key itself.
    if (value && value.length <= 128) return value
  } catch {
    // Best-effort; see above.
  }
  return undefined
}

function clearRetainedShareKey(workspaceId: string): void {
  try {
    window.sessionStorage.removeItem(retainedShareKeyStorageKey(workspaceId))
  } catch {
    // Best-effort; see above.
  }
}

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
  // The share key from the URL fragment, retained after the fragment is stripped. A failed or
  // cancelled first open reverts the redemption server-side, so a retry (the retry button, or a
  // reconnection) must re-send the key or it dead-ends on access-denied; never cleared on
  // failure -- that is the point. Retention has two tiers: this in-memory ref, and a
  // sessionStorage entry that also survives a reload. Both are discarded at the *first
  // successful open*: from then on the confirmed edge makes every retry resolvable keylessly,
  // and a kept key would re-redeem the still-active link after an owner removal (see the
  // success block below). The secret never enters the URL or history -- the fragment is
  // stripped before openGadget is even issued -- nor error reports (normalizePageLocation
  // keeps origin+pathname only); sessionStorage is same-origin, per-tab, and dies with the
  // tab, and gadget UIs run in opaque-origin frames that cannot read it.
  const retainedShareKeyRef = useRef<{ id: string; key: string } | null>(null)
  const pendingObserverRejectRef = useRef<((error: unknown) => void) | null>(null)
  const callbacksRef = useRef({ onMetadata, onShareKeyConsumed, onInvalidShareKey })
  callbacksRef.current = { onMetadata, onShareKeyConsumed, onInvalidShareKey }

  useDocumentTitle(error ? '' : metadata?.title)

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
        if (shareKey) {
          retainedShareKeyRef.current = { id, key: shareKey }
          writeRetainedShareKey(id, shareKey)
          callbacksRef.current.onShareKeyConsumed()
        } else if (retainedShareKeyRef.current?.id === id) {
          shareKey = retainedShareKeyRef.current.key
        } else {
          // A reload lost the in-memory ref; the sessionStorage tier is what keeps a failed
          // first open retryable across it.
          shareKey = readRetainedShareKey(id)
          if (shareKey) retainedShareKeyRef.current = { id, key: shareKey }
        }

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
        setOverseer({ stub: overseerStub })

        const resolvedSubscription = await overseerStub.subscribeToMetadata((nextMetadata) => {
          if (cancelled) return
          setMetadata(nextMetadata)
          callbacksRef.current.onMetadata(nextMetadata)
        })
        if (cancelled) {
          resolvedSubscription[Symbol.dispose]()
          return
        }
        metadataSubscription = resolvedSubscription

        openWorkspaceIdRef.current = id
        // The open succeeded, so the key's job is done: the redeemed edge is confirmed, and
        // every later retry or reconnect resolves keylessly from the permission graph. Discard
        // both retention tiers -- a *kept* key would silently re-redeem the still-active link
        // after an owner removes this collaborator (the revocation restart reconnects with a
        // new authenticatedApi, re-running this effect while the component stays mounted),
        // undoing the removal.
        retainedShareKeyRef.current = null
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
