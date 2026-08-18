import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  /** Current user info, fetched once on mount. Null while loading. */
  currentUser: AiChatAuthorInfo | null
  /** Whether the current user is a deployment admin. False while loading / for non-admins. */
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

export function AuthProvider({ children, authenticatedApi, onLogout }: AuthProviderProps) {
  const [currentUser, setCurrentUser] = useState<AiChatAuthorInfo | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled) setCurrentUser(info)
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
    <AuthContext.Provider value={{ authenticatedApi, logout: onLogout, currentUser, isAdmin }}>
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
