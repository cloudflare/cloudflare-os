import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { RpcStub } from 'capnweb'
import {
  AUTH_ERROR_CODES,
  getAuthErrorCode,
  type AuthenticatedApi,
  type PublicApi,
} from '@gadgets/workshop-shared/api'
import { ApiContext, type ApiSession } from './ApiContext'
import type { Connection } from './Connection'
import { devAutoLogin, devAutoLoginEnabled } from './devAutoLogin'
import { clearToken, readToken } from './token'

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

/**
 * Renders `children` once the connection is up and the user is signed in, and a short notice until
 * then. A dropped connection signs in again on the new one; meanwhile `children` stay as they are,
 * told that it is reconnecting (`ApiSession.reconnecting`), so that nothing open is lost. Only the
 * first connection is waited for with the page to itself.
 */
export const RpcGate = ({ connection, children }: { connection: Connection; children: ReactNode }) => {
  const { publicApi } = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  // The session records which connection it belongs to, so a new connection never reuses the old
  // one's disposed stub. (An object, because a stub in useState would be called as an updater.)
  const [state, setState] = useState<{ owner: RpcStub<PublicApi>; session: Session } | null>(null)

  useEffect(() => {
    if (!publicApi) return
    let cancelled = false
    let api: RpcStub<AuthenticatedApi> | undefined
    const finish = (session: Session) => {
      if (!cancelled) setState({ owner: publicApi, session })
    }

    const signIn = async () => {
      try {
        const token = readToken() ?? (devAutoLoginEnabled ? await devAutoLogin(publicApi) : null)
        if (!token) return finish({ phase: 'signedOut' })
        // Pipelined: whoami() goes out with authenticate(), and doubles as the token check.
        api = publicApi.authenticate(token)
        const value: ApiSession = { api, user: await api.whoami(), reconnecting: false }
        finish({ phase: 'ready', value, reconnecting: { ...value, reconnecting: true } })
      } catch (error) {
        if (getAuthErrorCode(error) === AUTH_ERROR_CODES.invalidSessionToken) {
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
  }, [publicApi])

  const session = publicApi && state?.owner === publicApi ? state.session : CONNECTING
  // What was signed in on the connection before, until this one is.
  const kept = state?.session.phase === 'ready' ? state.session : undefined
  if (session.phase === 'connecting' && kept) return <ApiContext value={kept.reconnecting}>{children}</ApiContext>

  switch (session.phase) {
    case 'connecting':
      return <Notice>Connecting…</Notice>
    case 'signedOut':
      return <Notice>You’re not signed in.</Notice>
    case 'failed':
      return <Notice>Couldn’t sign in: {session.message}</Notice>
    case 'ready':
      return <ApiContext value={session.value}>{children}</ApiContext>
  }
}
