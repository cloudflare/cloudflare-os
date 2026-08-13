import { createContext, useContext } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'

/**
 * Context to provide the RPC stub and connection state throughout the app.
 * The stub is wrapped in an object to avoid React's callable-state-setter issue.
 */
export const RpcContext = createContext<{ stub: RpcStub<PublicApi>; connectionLost: boolean } | null>(null)

export function useRpcStub(): RpcStub<PublicApi> {
  const ctx = useContext(RpcContext)
  if (!ctx) throw new Error('useRpcStub must be used within RpcContext.Provider')
  return ctx.stub
}

export function useConnectionLost(): boolean {
  const ctx = useContext(RpcContext)
  return ctx?.connectionLost ?? false
}
