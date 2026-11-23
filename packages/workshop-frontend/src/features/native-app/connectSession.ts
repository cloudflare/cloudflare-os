import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

type Api = Pick<AuthenticatedApi, 'completeConnectHandoff'>
type Connection = { api: Api; identity: Promise<AiChatAuthorInfo>; broken: boolean }
const connections = new WeakMap<Api, { session: NativeConnectSession; connection: Connection }>()

/** One useAuth owner, including its replacement RPC connections (not other mounted owners). */
export class NativeConnectSession {
  private current: Connection | null = null
  private changed = new Set<() => void>()

  track(api: Api & Pick<RpcStub<AuthenticatedApi>, 'onRpcBroken'>,
    identity: Promise<AiChatAuthorInfo>): () => void {
    const connection = { api, identity, broken: false }
    connections.set(api, { session: this, connection })
    this.current = connection
    this.notify()
    api.onRpcBroken(() => {
      connection.broken = true
      this.notify()
    })
    return () => {
      if (this.current === connection) this.current = null
      this.notify()
    }
  }

  private notify() { this.changed.forEach(notify => notify()) }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.changed.delete(changed)
        signal.removeEventListener('abort', aborted)
      }
      const changed = () => { cleanup(); resolve() }
      const aborted = () => { cleanup(); reject(signal.reason) }
      this.changed.add(changed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
  }

  async complete(start: Connection, ticket: string, nonce: string, signal: AbortSignal): Promise<void> {
    const owner = await start.identity
    if (owner.type !== 'user') throw new Error('Sign in again to connect an account.')
    for (;;) {
      signal.throwIfAborted()
      const connection = this.current
      if (!connection) throw new Error('You signed out. Start the connection again.')
      if (connection.broken) {
        await this.waitForChange(signal)
        continue
      }
      try {
        const user = await connection.identity
        if (this.current !== connection || connection.broken) continue
        signal.throwIfAborted()
        if (user.type !== 'user' || user.id !== owner.id) {
          throw new Error('The signed-in user changed. Start the connection again.')
        }
        await connection.api.completeConnectHandoff(ticket, nonce)
        return
      } catch (error) {
        // Retry only a broken/replaced transport, never a server rejection on a live session.
        // Ticket + nonce are single-use server-side, so a retry cannot apply the grant twice.
        if (this.current !== connection || connection.broken) continue
        throw error
      }
    }
  }
}

/** Capture the initiating identity now; pick its current connection only when the ticket returns. */
export const nativeConnectCompletion = (api: Api, nonce: string) => {
  const tracked = connections.get(api)
  return (ticket: string, signal: AbortSignal): Promise<void> => {
    if (!tracked) throw new Error('The sign-in session is unavailable. Sign in and try again.')
    return tracked.session.complete(tracked.connection, ticket, nonce, signal)
  }
}
