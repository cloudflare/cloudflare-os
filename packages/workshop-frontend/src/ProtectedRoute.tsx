import { ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { useAuth, CF_ACCESS_MODE } from './useAuth'
import { AuthProvider } from './AuthContext'
import LoginPage from './LoginPage'
import { Loader, Banner, Button } from '@cloudflare/kumo'
import { useT } from './i18n'

interface ProtectedRouteProps {
  children: ReactNode
  rpcStub: RpcStub<PublicApi>
}

export default function ProtectedRoute({ children, rpcStub }: ProtectedRouteProps) {
  const t = useT()
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } = useAuth(rpcStub)

  const handleLoginSuccess = () => {
    // Trigger re-authentication by calling login with stored token
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <Loader size="lg" />
        <div style={{ textAlign: 'center' }}>
          {t('common.loading')}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div
        style={{
          minHeight: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
        }}
      >
        <Banner
          variant="error"
          title={t('auth.authError', { error })}
          className="mb-4"
        />
        <Button variant="primary" onClick={() => window.location.reload()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  // In CF Access mode the user is always authenticated (Access enforces login before the
  // app loads), so we never show the login page. If not authenticated yet, keep the
  // spinner up while the pipelined authenticateFromCfAccess() call resolves.
  if (!isAuthenticated) {
    if (CF_ACCESS_MODE) {
      return (
        <div
          style={{
            minHeight: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <Loader size="lg" />
          <div style={{ textAlign: 'center' }}>
            Authenticating...
          </div>
        </div>
      )
    }
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  return (
    <AuthProvider authenticatedApi={authenticatedApi!} onLogout={logout}>
      {children}
    </AuthProvider>
  )
}
