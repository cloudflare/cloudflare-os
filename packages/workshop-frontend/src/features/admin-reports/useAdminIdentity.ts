import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, NamedUser } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

/**
 * The signed-in admin as issue reports name them: the id a report they hold carries as its
 * assignee's. Read once for each `admin` stub, and undefined until the read answers or when it
 * fails, so that whoever uses it shows nothing that depends on which reports are the admin's own.
 */
export const useAdminIdentity = (admin: RpcStub<AdminApi>): NamedUser | undefined => {
  const [me, setMe] = useState<NamedUser>()

  useEffect(() => {
    let current = true
    admin.whoami().then(
      (answer) => { if (current) setMe(answer) },
      (err: unknown) => { if (current) logRpcFailure('Failed to read who the admin is:', err) },
    )
    return () => {
      current = false
      // What an earlier stub answered is not known of the next one until it answers too.
      setMe(undefined)
    }
  }, [admin])

  return me
}
