import { logRpcFailure } from '../rpcErrors'
import { Activity, Suspense, useState, useEffect } from 'react'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, type FinanceHubStatus } from '@gadgets/workshop-shared/api'
import { useRpcStub, useConnectionLost } from '../RpcContext'
import { useAuth, CF_ACCESS_MODE } from '../useAuth'
import { AuthProvider } from '../AuthContext'
import { FeatureFlagsProvider } from '../FeatureFlagsContext'
import Header from '../components/Header'
import AppShell from '../components/AppShell/AppShell'
import LoginPage from '../LoginPage'
import OnboardingWizard from '../OnboardingWizard'
import AccountSelectionModal from '../components/billing/AccountSelectionModal'
import { SessionsProvider } from '../components/sessions/SessionsContext'
import { RequiredConnectionsGate } from '../RequiredConnectionsGate'
import { HubProvider } from '../HubContext'
import { useEnabledHubs } from '../ServerConfigContext'
import { AppLoadingSkeleton } from '../components/AppLoadingSkeleton'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  const rpcStub = useRpcStub()
  const connectionLost = useConnectionLost()
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login, switchIdentity, identityRevision } = useAuth(rpcStub)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Routes that don't require auth (public routes)
  const isSignup = pathname === '/signup'
  const isBlueprint = pathname.startsWith('/blueprint/')

  // A standalone (no app shell) render is used only for signed-out visitors of public routes.
  // Signed-in users get the full app chrome so public pages (esp. the blueprint detail) feel
  // native — sidebar and all — instead of floating on a bare page.
  const standalone = isSignup || (isBlueprint && !isAuthenticated)

  // The workspace editor renders fullscreen (no app chrome). /gadget/ is the legacy URL, kept
  // here so the chrome doesn't flash in during the redirect to /workspace/.
  const isWorkspaceEditor = pathname.startsWith('/workspace/') || pathname.startsWith('/gadget/')

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  // Auth error
  if (error && !standalone) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base p-6">
        <p className="text-sm text-kumo-danger">Authentication error: {error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  // CF Access mode: show spinner while pipelined auth resolves
  if (!isLoading && !isAuthenticated && CF_ACCESS_MODE && !standalone) {
    return <AppLoadingSkeleton label="Authenticating" />
  }

  // Not authenticated and not a public route — show login
  if (!isLoading && !isAuthenticated && !standalone) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  // Signed-out visitors of public routes render without the auth wrapper / app shell.
  if (standalone) {
    const showHeader = !isSignup
    return (
      <TooltipProvider>
        <Toasty>
          <div className="flex h-full min-h-0 flex-col">
            {showHeader && <Header />}
            <main className="min-h-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </Toasty>
      </TooltipProvider>
    )
  }

  // Keep visual state through reconnect, but disconnect every effect while authority is absent.
  // Logout and errors return above, deliberately destroying this boundary and its saved state.
  return (
    <>
      <Activity mode={isLoading ? 'hidden' : 'visible'}>
        <Suspense fallback={null}>
          <CurrentAuthenticatedContent
            key={identityRevision ?? 0}
            authenticatedApi={isLoading ? null : authenticatedApi}
            logout={logout}
            switchIdentity={switchIdentity}
            isWorkspaceEditor={isWorkspaceEditor}
            pathname={pathname}
          />
        </Suspense>
      </Activity>
      {isLoading && <AppLoadingSkeleton label={connectionLost ? 'Waiting for server' : 'Restoring session'} />}
    </>
  )
}

// A prop update with the replacement API retries this seam; no old capability is cached.
// Hidden Activities still render, so returning null here would discard the preserved subtree.
const waitingForAuthenticatedApi = new Promise<never>(() => {})

function CurrentAuthenticatedContent({ authenticatedApi, logout, switchIdentity, isWorkspaceEditor, pathname }: {
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  logout: () => void
  switchIdentity: (identity: string) => Promise<void>
  isWorkspaceEditor: boolean
  pathname: string
}) {
  if (!authenticatedApi) throw waitingForAuthenticatedApi
  return (
    <AuthProvider authenticatedApi={authenticatedApi} onLogout={logout} onSwitchIdentity={switchIdentity}>
      <FeatureFlagsProvider>
        <TooltipProvider>
          <Toasty>
            <AuthenticatedShell
              authenticatedApi={authenticatedApi}
              isWorkspaceEditor={isWorkspaceEditor}
              pathname={pathname}
            />
          </Toasty>
        </TooltipProvider>
      </FeatureFlagsProvider>
    </AuthProvider>
  )
}

/**
 * Inner shell that checks onboarding status and either shows the wizard
 * or the normal app chrome. Lives inside AuthProvider so the wizard can
 * use useAuthenticatedApi().
 */
function AuthenticatedShell({
  authenticatedApi,
  isWorkspaceEditor,
  pathname,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  isWorkspaceEditor: boolean
  pathname: string
}) {
  const enabledHubs = useEnabledHubs()
  // null = still checking, true = needs onboarding, false = onboarding done
  const [onboardingNeeded, setOnboardingNeeded] = useState<boolean | null>(null)
  const [financeStatus, setFinanceStatus] = useState<FinanceHubStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.isOnboardingCompleted().then((completed) => {
      if (!cancelled) setOnboardingNeeded(!completed)
    }).catch((err) => {
      logRpcFailure('Failed to check onboarding status:', err)
      // If the check fails, skip onboarding to avoid blocking the user
      if (!cancelled) setOnboardingNeeded(false)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getFinanceHubStatus().then((status) => {
      if (!cancelled) setFinanceStatus(status)
    }).catch((err) => {
      logRpcFailure('Failed to check Finance hub access:', err)
      if (!cancelled) setFinanceStatus({ authorized: false, canCreate: false })
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Still checking onboarding status
  if (onboardingNeeded === null) {
    return <AppLoadingSkeleton label="Preparing Odie OS" />
  }

  // Show onboarding wizard
  if (onboardingNeeded) {
    return <OnboardingWizard onComplete={() => setOnboardingNeeded(false)} />
  }

  // The left rail stays available on every authenticated page. Workspace editors start with the
  // rail collapsed and omit the desktop top bar so their canvas remains effectively fullscreen.
  const fullscreen = isWorkspaceEditor
  return (
    <HubProvider enabledHubs={enabledHubs} financeStatus={financeStatus}>
      <RequiredConnectionsGate authenticatedApi={authenticatedApi} pathname={pathname}>
        <AccountSelectionModal />
        <SessionsProvider loadRepositories={pathname === '/sessions'}>
          <AppShell key={fullscreen ? 'workspace' : 'app'} startCollapsed={fullscreen} fullscreenContent={fullscreen}>
            <Outlet />
          </AppShell>
        </SessionsProvider>
      </RequiredConnectionsGate>
    </HubProvider>
  )
}
