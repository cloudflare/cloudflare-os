import { createFileRoute } from '@tanstack/react-router'
import { ConnectHandoffPane } from '@/connections/ConnectHandoffPane'
import { RpcGate } from '@/rpc/RpcGate'
import { sharedConnection } from '@/rpc/sharedConnection'

/**
 * Where a connect popup ends, on its own outside the app's frame. The service's last page sends
 * the popup here by this address, so it cannot be moved (see `docs/connect-handoff.md`).
 */
export const Route = createFileRoute('/connect/handoff')({
  component: () => (
    <RpcGate connection={sharedConnection()}>
      <ConnectHandoffPane />
    </RpcGate>
  ),
})
