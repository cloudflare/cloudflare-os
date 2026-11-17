import { createContext, useContext } from 'react'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'

export type ApiSession = {
  /**
   * The signed-in API. A new connection brings a new one, so whatever holds stubs made from it
   * should start over on the new one when it changes.
   */
  api: RpcStub<AuthenticatedApi>
  user: AiChatAuthorInfo
  /**
   * The user changed something of their own that `user` says, such as their name, which the
   * server now has: `user` is this from here on, for everything that shows it.
   */
  userChanged: (user: AiChatAuthorInfo) => void
  /**
   * The connection was lost and is being made again. Meanwhile `api` is the lost connection's,
   * whose calls fail, and everything is left as it is until it is replaced.
   */
  reconnecting: boolean
}

export const ApiContext = createContext<ApiSession | null>(null)

/**
 * The signed-in API and user. Only available beneath `RpcGate`, which renders nothing until the
 * first sign-in.
 */
export const useApi = (): ApiSession => {
  const session = useContext(ApiContext)
  if (!session) throw new Error('useApi must be used inside RpcGate')
  return session
}
