import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  AuthenticatedApi,
  WorkspaceMetadata,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
  Overseer,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { reportIssue } from './errorReporting'
import { classifyRpcError } from './rpcErrors'
import { linkActionLog } from './useActions'
import { useDocumentTitle } from './useDocumentTitle'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from './components/WorkspaceOpenErrorPage'

const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'
const REOPEN_BACKOFF_MS = 1_000
const REOPEN_MAX_BACKOFF_MS = 60_000
const REOPEN_RETRIES_BEFORE_REPORT = 2

export type WorkspaceLoadError =
  | { kind: 'open'; failure: WorkspaceOpenFailureKind }
  | { kind: 'message'; message: string }

type ObserverConfigState = {
  needs: ObserverBindingNeed[]
  // The gadget whose opening asked, or undefined when the workspace's did, and whether its prompt
  // may offer a snapshot of it instead.
  gadget?: { id: WorkpieceId; offersSnapshot: boolean }
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: unknown) => void
}

class ObserverConfigTarget extends RpcTarget implements ObserverConfigCallback {
  #request: (needs: ObserverBindingNeed[]) => Promise<ObserverAccountChoice[]>

  constructor(request: (needs: ObserverBindingNeed[]) => Promise<ObserverAccountChoice[]>) {
    super()
    this.#request = request
  }

  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
    return this.#request(needs)
  }
}

/**
 * What to tell someone whom observer verification kept out of a workspace or gadget, or null when
 * opening it failed for another reason.
 */
export function observerOpenFailureMessage(caught: unknown, subject: 'workspace' | 'gadget'): string | null {
  const message = caught instanceof Error ? caught.message : ''
  if (message.includes(OBSERVER_CANCELLED)) {
    return `To open this ${subject}, you must choose connected accounts for the services it uses.`
  }
  if (message.includes('permitted to observe') ||
      message.includes('no longer connected') ||
      message.includes('connect an account for every service')) {
    return message
  }
  return null
}

/** Whether opening something failed because the collaborator cancelled its account prompt. */
export function isObserverConfigCancelled(caught: unknown): boolean {
  return caught instanceof Error && caught.message.includes(OBSERVER_CANCELLED)
}

type Options = {
  id: string | undefined
  authenticatedApi: RpcStub<AuthenticatedApi>
  onMetadata: (metadata: WorkspaceMetadata) => void
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
  const [metadata, setMetadata] = useState<WorkspaceMetadata | null>(null)
  const [error, setError] = useState<WorkspaceLoadError | null>(null)
  const [connectionLost, setConnectionLost] = useState(false)
  const [observerConfig, setObserverConfig] = useState<ObserverConfigState | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const openWorkspaceIdRef = useRef<string | undefined>(undefined)
  const reopenFailuresRef = useRef(0)
  const pendingObserverRef = useRef<ObserverConfigState | null>(null)
  const callbacksRef = useRef({ onMetadata, onShareKeyConsumed, onInvalidShareKey })
  callbacksRef.current = { onMetadata, onShareKeyConsumed, onInvalidShareKey }

  useDocumentTitle(error ? '' : metadata?.title)

  // A callback routing the overseer's account prompts to the picker until `signal` aborts. Gadget
  // opens need one each, naming their `gadget`, since a collaborator given individual gadgets is
  // verified per gadget. One prompt shows at a time: a newer one supersedes an unanswered one, whose
  // open then fails rather than holding the collaborator's admission open. Stable, as each gadget
  // open depends on it.
  const createObserverConfigCallback = useCallback((signal: AbortSignal, gadget?: ObserverConfigState['gadget']) =>
    new RpcStub<ObserverConfigCallback>(new ObserverConfigTarget(needs =>
      new Promise<ObserverAccountChoice[]>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('Cancelled'))
          return
        }
        const settle = (finish: () => void) => {
          signal.removeEventListener('abort', onAbort)
          if (pendingObserverRef.current === request) {
            pendingObserverRef.current = null
            setObserverConfig(null)
          }
          finish()
        }
        const request: ObserverConfigState = {
          needs,
          gadget,
          resolve: choices => settle(() => resolve(choices)),
          reject: observerError => settle(() => reject(observerError)),
        }
        const onAbort = () => request.reject(new Error('Cancelled'))
        signal.addEventListener('abort', onAbort)
        pendingObserverRef.current?.reject(new Error('Cancelled'))
        pendingObserverRef.current = request
        setObserverConfig(request)
      }))), [])

  useEffect(() => {
    let overseerStub: RpcStub<Overseer> | null = null
    let metadataSubscription: RpcStub<{}> | null = null
    let configureObservers: RpcStub<ObserverConfigCallback> | null = null
    let cancelled = false
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
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
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) callbacksRef.current.onShareKeyConsumed()

        configureObservers = createObserverConfigCallback(abort.signal)

        overseerStub = authenticatedApi.openWorkspace(id, shareKey, configureObservers)
        linkActionLog(overseerStub, id)
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
        reopenFailuresRef.current = 0
        setError(null)
        if (connectionLost) setConnectionLost(false)
      } catch (caught) {
        if (cancelled) return
        console.error('Failed to load gadget:', caught)

        // TODO: Give invalid-share-key and observer failures stable codes so this remaining legacy
        // message classification can be removed.
        const message = caught instanceof Error ? caught.message : ''
        if (message.includes('Invalid or expired share key')) {
          callbacksRef.current.onInvalidShareKey()
        }
        const observerFailure = observerOpenFailureMessage(caught, 'workspace')
        if (observerFailure !== null) {
          showTerminalError({ kind: 'message', message: observerFailure })
        } else {
          const failure = classifyWorkspaceOpenFailure(caught)
          if (failure !== 'unexpected') {
            showTerminalError({ kind: 'open', failure })
          } else if (!hadOpenWorkspace) {
            reportIssue('gadget.load', caught, { gadgetId: id })
            showTerminalError({ kind: 'open', failure })
          } else {
            if (!connectionLost) setConnectionLost(true)
            // On a live connection nothing else replaces the stub that failed to reopen.
            // A socket that dropped mid-reopen is the connection manager's to recover, so it does
            // not count. Only a failure two retries have not cured is reported, and an expired
            // session never is.
            const errorClass = classifyRpcError(caught)
            const failures = errorClass === 'connection' ? 0 : reopenFailuresRef.current++
            if (failures === REOPEN_RETRIES_BEFORE_REPORT && errorClass !== 'auth') {
              reportIssue('gadget.reopen', caught, { severity: 'warning', gadgetId: id })
            }
            const backoff = Math.min(REOPEN_BACKOFF_MS * 2 ** failures, REOPEN_MAX_BACKOFF_MS)
            reopenTimer = setTimeout(
              () => setReloadNonce(value => value + 1), backoff * (0.85 + 0.3 * Math.random()))
          }
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      clearTimeout(reopenTimer)
      abort.abort()
      disposeAttempt()
    }
  }, [id, authenticatedApi, reloadNonce, createObserverConfigCallback])

  return {
    overseer,
    metadata,
    error,
    connectionLost,
    observerConfig,
    createObserverConfigCallback,
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
