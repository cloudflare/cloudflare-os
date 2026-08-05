import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'

const CF_ACCESS_MODE = import.meta.env.VITE_CF_ACCESS_MODE === 'true'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
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
  authenticatedApiRef.current = authState.authenticatedApi

  useEffect(() => {
    if (CF_ACCESS_MODE) {
      authenticateWithCfAccess()
    } else {
      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        authenticateWithToken(storedToken)
      } else {
        setAuthState(prev => ({ ...prev, isLoading: false }))
      }
    }
    return () => {
      // The authenticateWithXxx functions also dispose the old stub via their setAuthState
      // updater, so this may double-dispose on reconnect. That's fine — dispose is idempotent.
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [publicApi])

  const authenticateWithCfAccess = () => {
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
    setAuthState({
      token: null,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const authenticateWithToken = (token: string) => {
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
    setAuthState({
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    })
  }

  const login = (token: string) => {
    authenticateWithToken(token)
  }

  const logout = () => {
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

    localStorage.removeItem('authToken')
  }

  return {
    ...authState,
    login,
    logout,
    isAuthenticated: !!authState.authenticatedApi
  }
}
