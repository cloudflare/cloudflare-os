import { createFileRoute } from '@tanstack/react-router'
import { ConnectHandoffPane } from '@/connections/ConnectHandoffPane'
import { RpcGate } from '@/rpc/RpcGate'
import { sharedConnection } from '@/rpc/sharedConnection'

/**
 * Where a connect popup ends, to redeem its ticket (`ConnectHandoffPane`). On its own, outside the
 * frame: it is a popup, which is closed once it is done.
 */
export const Route = createFileRoute('/connect/handoff')({
  component: () => (
    <RpcGate connection={sharedConnection()}>
      <ConnectHandoffPane />
    </RpcGate>
  ),
})
