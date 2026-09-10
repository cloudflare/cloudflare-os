import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  /** Switch to another existing identity authorized by fresh SSO. */
  switchIdentity?: (identity: string) => Promise<void>
  /** Current user verified by this exact API. Null while its identity is unresolved. */
  currentUser: AiChatAuthorInfo | null
  /** Whether the current user is a deployment admin. False while loading / for non-admins. */
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
  onSwitchIdentity?: (identity: string) => Promise<void>
}

export function AuthProvider({ children, authenticatedApi, onLogout, onSwitchIdentity }: AuthProviderProps) {
  const [identity, setIdentity] = useState<{ api: RpcStub<AuthenticatedApi>; user: AiChatAuthorInfo }>()
  const currentUser = identity?.api === authenticatedApi ? identity.user : null
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled) setIdentity({ api: authenticatedApi, user: info })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.amIAdmin().then((admin) => {
      if (!cancelled) setIsAdmin(admin)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  return (
    <AuthContext.Provider value={{ authenticatedApi, logout: onLogout, switchIdentity: onSwitchIdentity, currentUser, isAdmin }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

/** Returns the auth context when inside an AuthProvider, or null on public pages. */
export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}
