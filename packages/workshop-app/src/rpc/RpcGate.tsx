import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import {
  AUTH_ERROR_CODES,
  getAuthErrorCode,
  resolveSiteName,
  type AiChatAuthorInfo,
  type AuthenticatedApi,
  type PublicApi,
} from '@gadgets/workshop-shared/api'
import { SignInForm, type SignInMode } from '@/blocks/SignInForm'
import { ApiContext, type ApiSession } from './ApiContext'
import { readServerConfig, useServerConfig } from './serverConfig'
import type { Connection } from './Connection'
import { ConnectionNotice } from './ConnectionNotice'
import { ConnectionNoticeContext } from './ConnectionNoticeContext'
import { setReportedUserId } from './errorReporting'
import { SignInPane } from './SignInPane'
import { clearToken, readToken, storeToken } from './token'

type Session =
  | { phase: 'connecting' }
  | { phase: 'signedOut' }
  | { phase: 'failed'; message: string }
  // With the same session as it is shown while a lost connection is made again.
  | { phase: 'ready'; value: ApiSession; reconnecting: ApiSession }

const CONNECTING: Session = { phase: 'connecting' }

const Notice = ({ children }: { children: ReactNode }) => (
  <div className="grid h-full place-items-center p-6 text-base text-kumo-subtle">{children}</div>
)

export type RpcGateProps = {
  connection: Connection
  /** Where the sign-in page starts, for whoever is signed out: signing in, or making an account. */
  startsAt?: SignInMode
  children: ReactNode
}

/**
 * Renders `children` once the connection is up and the user is signed in, and a short notice until
 * then. A dropped connection signs in again on the new one; meanwhile `children` stay as they are,
 * told that it is reconnecting (`ApiSession.reconnecting`), so that nothing open is lost. Only the
 * first connection is waited for with the page to itself. What the user is told meanwhile, and
 * whether what they ask for can be done, is the `ConnectionNotice` it provides.
 *
 * The user is signed in with the token this browser keeps (`token.ts`), or, where the deployment
 * says it is behind Cloudflare Access (`ServerConfig.authMode`), as whoever Access says: Access
 * signed them in before the page could load, so the sign-in page is never shown. Signed out, the
 * sign-in page (`SignInPane`) is in place of `children`, at the address the user was going to, so
 * that signing in shows them what they were going to.
 */
export const RpcGate = ({ connection, startsAt, children }: RpcGateProps) => {
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  // The session records which connection it belongs to, so a new connection never reuses the old
  // one's disposed stub. (An object, because a stub in useState would be called as an updater.)
  const [state, setState] = useState<{ owner: RpcStub<PublicApi>; session: Session } | null>(null)
  const [notice] = useState(() => new ConnectionNotice())
  // Bumped once a token is stored, to sign in with it, and to try Cloudflare Access again.
  const [signIns, setSignIns] = useState(0)
  // Stable, as the sign-in page starts over on a new one.
  const [tokenReceived] = useState(() => (token: string) => {
    storeToken(token)
    setSignIns((n) => n + 1)
  })
  const config = useServerConfig()
  const siteName = resolveSiteName(config?.siteName)
  const access = config?.authMode === 'cfAccess'
  // Stable, as the session it is part of is kept by whatever reads it.
  const [userChanged] = useState(() => (user: AiChatAuthorInfo) =>
    setState((current) =>
      current?.session.phase === 'ready'
        ? { ...current, session: { phase: 'ready', value: { ...current.session.value, user }, reconnecting: { ...current.session.reconnecting, user } } }
        : current))

  useEffect(() => {
    if (!publicApi) return
    let cancelled = false
    let api: RpcStub<AuthenticatedApi> | undefined
    const finish = (session: Session) => {
      if (cancelled) return
      // A label on what goes wrong from here on, never anything decided by.
      if (session.phase !== 'failed') setReportedUserId(session.phase === 'ready' ? session.value.user.id : undefined)
      setState({ owner: publicApi, session })
    }

    const signIn = async () => {
      let viaAccess = false
      try {
        viaAccess = (await (readServerConfig() ?? publicApi.getServerConfig())).authMode === 'cfAccess'
        if (viaAccess) {
          // Access signed the user in before the page could load, and its session goes with every
          // request, so there is no token to keep.
          api = publicApi.authenticateFromCfAccess()
        } else {
          // Written out where it is used, so that a build, where it is `false`, drops the import and
          // everything behind it, the dev account's password included.
          const token = readToken() ?? (import.meta.env.DEV && import.meta.env.VITE_DEV_AUTO_LOGIN === 'true'
            ? await (await import('./devAutoLogin')).devAutoLogin(publicApi)
            : null)
          if (!token) return finish({ phase: 'signedOut' })
          api = publicApi.authenticate(token)
        }
        // Pipelined: whoami() goes out with the sign-in, and doubles as its check.
        const value: ApiSession = { api, user: await api.whoami(), userChanged, reconnecting: false }
        finish({ phase: 'ready', value, reconnecting: { ...value, reconnecting: true } })
      } catch (error) {
        if (!viaAccess && getAuthErrorCode(error) === AUTH_ERROR_CODES.invalidSessionToken) {
          clearToken()
          finish({ phase: 'signedOut' })
        } else {
          finish({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    void signIn()

    return () => {
      cancelled = true
      api?.[Symbol.dispose]()
    }
  }, [publicApi, signIns, userChanged])

  const session = publicApi && state?.owner === publicApi ? state.session : CONNECTING
  // What was signed in on the connection before, until this one is.
  const kept = state?.session.phase === 'ready' ? state.session : undefined
  const reconnecting = session.phase === 'connecting' && kept !== undefined

  // Before the passive effects beneath, which may ask whether it is down.
  useLayoutEffect(() => {
    if (reconnecting) notice.lost()
    else notice.restored()
  }, [notice, reconnecting])
  // The browser knows when the device has no network, and when it is back, which is worth trying at once.
  useEffect(() => {
    const update = () => {
      notice.setOffline(!navigator.onLine)
      if (navigator.onLine) connection.retryNow()
    }
    notice.setOffline(!navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [notice, connection])

  const signedIn = (value: ApiSession) => (
    <ConnectionNoticeContext value={notice}>
      <ApiContext value={value}>{children}</ApiContext>
    </ConnectionNoticeContext>
  )
  if (reconnecting) return signedIn(kept.reconnecting)

  switch (session.phase) {
    case 'connecting':
      return access ? <SignInForm siteName={siteName} state="access" /> : <Notice>Connecting…</Notice>
    case 'signedOut':
      return <SignInPane publicApi={publicApi!} startsAt={startsAt} onToken={tokenReceived} />
    case 'failed':
      return access
        ? <SignInForm siteName={siteName} state="access" problem={session.message} onRetry={() => setSignIns((n) => n + 1)} />
        : <Notice>Couldn’t sign in: {session.message}</Notice>
    case 'ready':
      return signedIn(session.value)
  }
}
