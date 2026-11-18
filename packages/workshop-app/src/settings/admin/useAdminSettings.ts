import { useEffect, useRef, useState } from 'react'
import type { AdminSettingsView } from '@gadgets/workshop-shared/api'
import { messageOf } from '../useAttempt'
import { useAdmin, type AdminCapability } from './AdminContext'

export type AdminSettingsState =
  | { status: 'loading' }
  | { status: 'ready'; view: AdminSettingsView }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * The deployment's settings as an admin reads them (`AdminApi.getSettings()`), read as the part
 * that shows them opens, with the ways to show a change at once and to read them again. Only the
 * latest read is shown, so one that answers late cannot put back what a later one showed. What was
 * read stays up over a lost connection, and is read again over the new one.
 */
export const useAdminSettings = () => {
  const admin = useAdmin()
  const [state, setState] = useState<AdminSettingsState>({ status: 'loading' })
  const [attempts, setAttempts] = useState(0)
  const reads = useRef(0)

  useEffect(() => {
    if (!admin) return
    let cancelled = false
    const read = ++reads.current
    admin.getSettings().then(
      (view) => {
        if (!cancelled && read === reads.current) setState({ status: 'ready', view })
      },
      (error) => {
        if (cancelled || read !== reads.current) return
        // What was shown stays up when it could not be read again.
        setState((current) => current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry: () => setAttempts((count) => count + 1) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [admin, attempts])

  /** Reads the settings again, resolving once what was read is shown. Rejects where it could not be read. */
  const reload = async () => {
    if (!admin) return
    const read = ++reads.current
    const view = await admin.getSettings()
    if (read === reads.current) setState({ status: 'ready', view })
  }

  /** Shows the settings as they are now known to be, such as written as the server keeps them. */
  const show = (shown: (view: AdminSettingsView) => AdminSettingsView) =>
    setState((current) => current.status === 'ready' ? { status: 'ready', view: shown(current.view) } : current)

  /**
   * Shows what a change does at once (`shown`, over what is shown), then makes it. Where it is
   * refused, what the server holds is read again, and the refusal goes on to the caller.
   */
  const change = async (shown: (view: AdminSettingsView) => AdminSettingsView, call: (admin: AdminCapability) => Promise<unknown>) => {
    if (!admin) throw new Error('Not connected yet.')
    show(shown)
    try {
      await call(admin)
    } catch (error) {
      void reload().catch(() => {})
      throw error
    }
  }

  return { admin, state, reload, change, show }
}
