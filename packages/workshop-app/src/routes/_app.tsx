import { createFileRoute, Outlet } from '@tanstack/react-router'
import { RpcGate } from '@/rpc/RpcGate'
import { sharedConnection } from '@/rpc/sharedConnection'

/** Everything under here needs the backend; routes outside it (the gallery) work without one. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <RpcGate connection={sharedConnection()}>
      <Outlet />
    </RpcGate>
  ),
})
