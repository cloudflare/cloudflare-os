import { createFileRoute, Navigate } from '@tanstack/react-router'
import { RpcGate } from '@/rpc/RpcGate'
import { sharedConnection } from '@/rpc/sharedConnection'

/**
 * Making an account, where `workshop-frontend` has it, so that a link to it from before still
 * goes there: the sign-in page started at making one, then home once signed in. Anywhere else, the
 * sign-in page offers it in place, and signing up shows what the user was going to.
 */
export const Route = createFileRoute('/signup')({
  component: () => (
    <RpcGate connection={sharedConnection()} startsAt="signUp">
      <Navigate to="/" replace />
    </RpcGate>
  ),
})
