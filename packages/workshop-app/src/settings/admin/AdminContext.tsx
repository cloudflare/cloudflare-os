import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useApi, type ApiSession } from '@/rpc/ApiContext'

/**
 * The deployment's admin capability: the promise of `getAdminApi()`, not what that resolves to,
 * as it is where it is not null. Calls are made on it at once and travel with the call for it,
 * which is how Cap'n Web pipelines them. Someone who is not an admin gets null, and every call on
 * it then fails, which only what is shown to admins makes.
 */
export type AdminCapability = Exclude<ReturnType<ApiSession['api']['getAdminApi']>, PromiseLike<null>>

// Wrapped, as a stub looks callable to whatever might call a function it is given.
type Held = { admin: AdminCapability }

const AdminContext = createContext<Held | null>(null)

/**
 * Holds the deployment's admin capability for whatever is beneath it while `enabled`, which is
 * for an admin, until it unmounts or the connection is made again, when it is let go of and
 * another is asked for. One for a visit to the settings, so that what an admin does there is one
 * session in the audit log.
 */
export const AdminProvider = ({ enabled, children }: { enabled: boolean; children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [held, setHeld] = useState<Held & { api: object }>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks again.
    if (!enabled || reconnecting) return
    // Disposing the promise disposes what it resolves to.
    const admin = api.getAdminApi() as AdminCapability
    setHeld({ api, admin })
    return () => admin[Symbol.dispose]()
  }, [api, reconnecting, enabled])

  // One asked for over the lost connection is not offered once the new one is up.
  return <AdminContext value={enabled && held?.api === api ? held : null}>{children}</AdminContext>
}

/** A capability of its own for what is beneath, such as the gallery's, in place of the server's. */
export const AdminCapabilityProvider = ({ admin, children }: { admin: AdminCapability; children: ReactNode }) => {
  const [held] = useState<Held>(() => ({ admin }))
  return <AdminContext value={held}>{children}</AdminContext>
}

/** The deployment's admin capability, or null while it is asked for. Only beneath an `AdminProvider`. */
export const useAdmin = (): AdminCapability | null => useContext(AdminContext)?.admin ?? null
