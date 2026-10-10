import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { isSnoozed, recordDismissal, type DismissalStorage } from './updateNoticeDismissal'
import { useUpdateStatus } from './useUpdateStatus'

// Reaches `localStorage` only when called, inside the dismissal helpers' try/catch: merely reading
// the global throws where storage is blocked.
const browserStorage: DismissalStorage = {
  getItem: key => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}

/**
 * Tells an admin, with a persistent toast, that a newer release is available. Closing the toast
 * hides it in this browser for the deployment's snooze period; "View update" opens the admin
 * Updates tab without snoozing it. Renders nothing itself.
 */
export const UpdateAvailableNotice = () => {
  const status = useUpdateStatus()
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  // The manager is a new object on every render and re-renders this component whenever the toast
  // list changes, so the effect reads it through a ref rather than depending on it.
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts

  const shouldShow = status?.notify === true &&
    !isSnoozed(browserStorage, Date.now(), status.noticeSnoozeHours)

  useEffect(() => {
    if (!shouldShow) return
    // onClose fires for every close, this effect's own cleanup included, so the cleanup marks its
    // close as not the admin's. Local to the run, as StrictMode replays the cleanup on mount.
    let closingOwnToast = false
    // No fixed id: Kumo drops an add whose id is still live or ending, which a remount would hit.
    const id: string = toastsRef.current.add({
      title: 'Update available',
      description: 'A newer release is available for this deployment.',
      variant: 'info',
      timeout: 0,
      actions: [{
        children: 'View update',
        variant: 'primary',
        onClick: () => { void navigateRef.current({ to: '/admin', search: { tab: 'updates' } }) },
      }],
      onClose: () => {
        if (!closingOwnToast) recordDismissal(browserStorage, Date.now())
      },
    })
    return () => {
      closingOwnToast = true
      toastsRef.current.close(id)
    }
  }, [shouldShow])

  return null
}
