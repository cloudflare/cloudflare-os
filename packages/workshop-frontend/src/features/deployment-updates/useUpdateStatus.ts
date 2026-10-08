import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'

/**
 * Whether a newer release is available, for an admin of a deployment the deploy flow installed.
 * Null for everyone else, while loading, and when the read fails. A non-admin makes no call.
 */
export const useUpdateStatus = (): DeploymentUpdateStatus | null => {
  const { authenticatedApi, isAdmin } = useAuthenticatedApi()
  const [status, setStatus] = useState<DeploymentUpdateStatus | null>(null)

  useEffect(() => {
    if (!isAdmin) return
    // capnweb does not promise that disposing a stub rejects the calls in flight on it, so a
    // cancelled run is ignored by flag as well as having its stub disposed.
    let cancelled = false
    let admin: RpcStub<AdminApi> | null = null
    const release = () => {
      admin?.[Symbol.dispose]()
      admin = null
    }

    authenticatedApi.getAdminApi()
      .then(async (api) => {
        if (!api) return null
        admin = api
        if (cancelled) {
          release()
          return null
        }
        return await api.getUpdateStatus()
      })
      .then(
        (next) => { if (!cancelled) setStatus(next) },
        (err) => {
          if (cancelled) return
          logRpcFailure('Failed to check for a deployment update:', err)
          setStatus(null)
        },
      )
      .finally(release)

    return () => {
      cancelled = true
      release()
    }
  }, [authenticatedApi, isAdmin])

  return isAdmin ? status : null
}
