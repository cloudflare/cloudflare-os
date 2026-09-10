import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { addNativeLoginTokenListener, getWorkshopRuntime } from './runtime'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
  identityRevision?: number
}

export { CF_ACCESS_MODE }

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null
  })

  // Track current authenticated API stub for cleanup on unmount.
  // State closures go stale in cleanup functions, so we use a ref.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  // In-memory and scoped to this login: reconnect can restore a choice, another login cannot.
  const identityPreference = useRef<{ scope: string; identity: string } | null>(null)
  const authGeneration = useRef(0)
  const pendingIdentityApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi

  /**
   * Names the signed-in user on error reports, for as long as this stub is the current one.
   *
   * Keyed on the stub rather than called from each authenticate path, so it covers however the
   * session was established — stored token, inline login, or CF Access. This is why the claim lives
   * in the hook and not in `AuthProvider`: the public blueprint page renders outside that provider
   * and logs in inline, so reports from the rest of its session would otherwise name nobody.
   *
   * `whoami` is pipelined rather than awaited, so its answer can outlive the session that asked.
   * The cleanup drops it when the stub is replaced or cleared, which is what stops a logout or a
   * newer login from being overwritten by the previous user. Disposal would not be enough on its
   * own: capnweb does not guarantee that disposing a stub rejects calls already in flight.
   *
   * Nothing is cleared here. Cleanup also runs on unmount, and two instances of this hook can be
   * mounted at once — the blueprint page runs its own inside the root's — so an inner one going
   * away must not blank an identity the outer still holds. `logout` is the only thing that clears.
   */
  useEffect(() => {
    const authenticatedApi = authState.authenticatedApi
    if (!authenticatedApi) return
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      // Only a real user account names a person: for a gadget author `id` is its owner's id.
      if (!cancelled && info.type === 'user') setReportedUserId(info.id)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authState.authenticatedApi])

  useEffect(() => addNativeLoginTokenListener((token) => authenticateWithToken(token)), [publicApi])

  useEffect(() => {
    let cancelled = false
    const generation = ++authGeneration.current
    // A replacement PublicApi means the previous WebSocket died. Remove its authenticated child
    // capability before painting another actionable screen; otherwise a fast click during native
    // foreground recovery can invoke a stub that the effect cleanup has already disposed.
    setAuthState(prev => {
      prev.authenticatedApi?.[Symbol.dispose]()
      return { ...prev, authenticatedApi: null, isLoading: true, error: null }
    })
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
    } else {
      getWorkshopRuntime().readSessionSecret()
        .then((storedToken) => {
          if (cancelled || generation !== authGeneration.current) return
          if (storedToken) authenticateWithToken(storedToken)
          else setAuthState(prev => ({ ...prev, isLoading: false }))
        })
        .catch((error) => {
          if (!cancelled) setAuthState(prev => ({ ...prev, isLoading: false, error: error instanceof Error ? error.message : 'Could not read session' }))
        })
    }
    return () => {
      cancelled = true
      ++authGeneration.current
      // The authenticateWithXxx functions also dispose the old stub via their setAuthState
      // updater, so this may double-dispose on reconnect. That's fine — dispose is idempotent.
      authenticatedApiRef.current?.[Symbol.dispose]()
      pendingIdentityApiRef.current?.[Symbol.dispose]()
      pendingIdentityApiRef.current = null
    }
  }, [publicApi])

  const authenticateWithCfAccess = () => {
    const generation = ++authGeneration.current
    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return { ...prev, authenticatedApi: null, isLoading: true, error: null }
    })

    // Use promise pipelining - no need to await. The CF Access JWT is already attached
    // to the request by the browser (injected by the Access service worker/cookie), so
    // the server validates it and returns an authenticated stub immediately.
    const authenticatedApi = publicApi.authenticateFromCfAccess()
    restoreIdentity(authenticatedApi, null, generation)
  }

  const restoreIdentity = (authenticatedApi: RpcStub<AuthenticatedApi>, token: string | null,
      generation: number) => {
    pendingIdentityApiRef.current?.[Symbol.dispose]()
    pendingIdentityApiRef.current = null
    const preference = identityPreference.current
    if (preference) {
      pendingIdentityApiRef.current = authenticatedApi
      void (async () => {
        let selected = authenticatedApi
        try {
          const scope = token ?? `access:${(await authenticatedApi.whoami()).id}`
          if (generation !== authGeneration.current) {
            authenticatedApi[Symbol.dispose]()
            return
          }
          if (scope === preference.scope) {
            selected = await authenticatedApi.switchAccountIdentity(preference.identity)
            authenticatedApi[Symbol.dispose]()
          } else {
            identityPreference.current = null
          }
          if (generation !== authGeneration.current) {
            selected[Symbol.dispose]()
            return
          }
          setAuthState(prev => ({ ...prev, token, authenticatedApi: selected, isLoading: false, error: null }))
        } catch (error) {
          authenticatedApi[Symbol.dispose]()
          if (generation === authGeneration.current) setAuthState(prev => ({ ...prev,
            authenticatedApi: null, isLoading: false,
            error: error instanceof Error ? error.message : 'Could not restore account identity' }))
        } finally {
          if (pendingIdentityApiRef.current === authenticatedApi) pendingIdentityApiRef.current = null
        }
      })()
      return
    }
    setAuthState(prev => ({
      ...prev,
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    }))
  }

  const authenticateWithToken = (token: string) => {
    const generation = ++authGeneration.current
    setAuthState(prev => {
      // Dispose the previous authenticated API stub if it exists
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        ...prev,
        authenticatedApi: null, // Clear the disposed stub
        isLoading: true,
        error: null
      }
    })

    // Use promise pipelining - we can use the returned promise as a stub immediately
    // without awaiting. Authentication errors will be handled when the stub is actually used.
    const authenticatedApi = publicApi.authenticate(token)
    restoreIdentity(authenticatedApi, token, generation)
  }

  const switchIdentity = async (identity: string) => {
    const source = authState.authenticatedApi
    if (!source) throw new Error('Sign in before switching accounts.')
    const generation = authGeneration.current
    const scope = identityPreference.current?.scope ?? authState.token ?? `access:${(await source.whoami()).id}`
    const selected = await source.switchAccountIdentity(identity)
    if (generation !== authGeneration.current) {
      selected[Symbol.dispose]()
      throw new Error('The login changed while switching accounts.')
    }
    ++authGeneration.current
    identityPreference.current = { scope, identity }
    source[Symbol.dispose]()
    authenticatedApiRef.current = selected
    setReportedUserId(undefined)
    setAuthState(prev => ({ ...prev, authenticatedApi: selected,
      identityRevision: (prev.identityRevision ?? 0) + 1 }))
  }

  const login = (token: string) => {
    identityPreference.current = null
    setAuthState(prev => ({ ...prev, identityRevision: (prev.identityRevision ?? 0) + 1 }))
    void getWorkshopRuntime().writeSessionSecret(token).catch(() => {})
    authenticateWithToken(token)
  }

  const logout = () => {
    ++authGeneration.current
    identityPreference.current = null
    setReportedUserId(undefined)
    pendingIdentityApiRef.current?.[Symbol.dispose]()
    pendingIdentityApiRef.current = null

    if (CF_ACCESS_MODE) {
      window.location.assign('/cdn-cgi/access/logout')
      return
    }

    // Use functional updater to read current state (avoids stale closure).
    setAuthState(prev => {
      if (prev.authenticatedApi) {
        prev.authenticatedApi[Symbol.dispose]()
      }
      return {
        token: null,
        authenticatedApi: null,
        isLoading: false,
        error: null
      }
    })

    void getWorkshopRuntime().clearSessionSecret().catch(() => {})
  }

  return {
    ...authState,
    login,
    logout,
    switchIdentity,
    isAuthenticated: !!authState.authenticatedApi
  }
}
