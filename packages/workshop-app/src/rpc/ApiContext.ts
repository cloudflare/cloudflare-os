import { createContext, useContext } from 'react'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'

export type ApiSession = {
  api: RpcStub<AuthenticatedApi>
  user: AiChatAuthorInfo
}

export const ApiContext = createContext<ApiSession | null>(null)

/** The signed-in API and user. Only available beneath `RpcGate`, which renders nothing until ready. */
export const useApi = (): ApiSession => {
  const session = useContext(ApiContext)
  if (!session) throw new Error('useApi must be used inside RpcGate')
  return session
}
