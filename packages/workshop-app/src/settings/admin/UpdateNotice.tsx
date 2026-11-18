import { useEffect, useState } from 'react'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import type { AdminCapability } from './AdminContext'
import { useIsAdmin } from './useIsAdmin'
import { probeRouterTag } from './updates/probeRouterTag'
import { isSnoozed, recordDismissal, type DismissalStorage } from './updates/updateNoticeDismissal'
import { UpdateNoticeView } from './updates/UpdateNoticeView'

// Reaches `localStorage` only when called, within the dismissal's own try/catch: merely reading
// the global throws where storage is blocked.
const browserStorage: DismissalStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}

/**
 * Tells an admin that a newer release of the deployment is out, as main's Home does, until they
 * close it, which hides it in this browser for as long as the deployment says (its notice
 * snooze). View update goes to it (`onOpen`) without closing it. Anyone else, and an admin of a
 * deployment the deploy flow did not install or with nothing new, is shown nothing. It asks for a
 * capability of its own (pipelined, let go of once read), as it is shown outside the settings.
 */
export const UpdateNotice = ({ onOpen }: { onOpen: () => void }) => {
  const { api, reconnecting } = useApi()
  const admin = useIsAdmin()
  // Kept with the connection it was read over, so that a new one says nothing until it has read.
  const [read, setRead] = useState<{ api: object; update: DeploymentUpdateStatus | null }>()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!admin || reconnecting) return
    let cancelled = false
    const capability = api.getAdminApi() as AdminCapability
    let held = true
    const release = () => {
      if (held) capability[Symbol.dispose]()
      held = false
    }
    probeRouterTag()
      .then(() => capability.getUpdateStatus())
      .then(
        (update) => {
          if (!cancelled) setRead({ api, update })
        },
        // Not knowing of an update is not having one to tell of.
        () => {},
      )
      .finally(release)
    return () => {
      cancelled = true
      release()
    }
  }, [api, reconnecting, admin])

  const update = read?.api === api ? read.update : null
  if (!admin || dismissed || !update?.notify || isSnoozed(browserStorage, Date.now(), update.noticeSnoozeHours)) return null
  return (
    <UpdateNoticeView
      onOpen={onOpen}
      onDismiss={() => {
        recordDismissal(browserStorage, Date.now())
        setDismissed(true)
      }}
    />
  )
}
