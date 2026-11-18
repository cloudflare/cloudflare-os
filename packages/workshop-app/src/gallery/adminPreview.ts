import type { AdminApi, AdminSettingsView } from '@gadgets/workshop-shared/api'
import type { AdminCapability } from '@/settings/admin/AdminContext'

/** The deployment's settings the admin parts' previews start from, as `AdminApi.getSettings()` gives them. */
export const PREVIEW_ADMIN_SETTINGS: AdminSettingsView = {
  signupsEnabled: true,
  userSearchEnabled: false,
  adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'metadata' },
  adminAuditRetentionDays: { effective: 365, chosen: 365, min: 90 },
  siteName: '',
  instanceInstructions: 'ACME Corp is a logistics company. Prefer metric units.',
  announcement: '',
  banner: { text: 'Scheduled maintenance on Saturday from 9:00 UTC.', color: 'warning' },
  accentColor: '',
  restrictedWebFetchHosts: ['docs.example.com', 'status.example.com'],
  restrictedWebFetchApprovals: false,
  resourceVendors: [],
  formats: [],
}

type Methods = { [Method in keyof AdminApi]?: (...args: Parameters<AdminApi[Method]>) => ReturnType<AdminApi[Method]> }

/**
 * An admin capability for the gallery, with `methods` in place of the server's (which should take
 * a moment, `previewDelay`, as a call does): a call to any other is refused.
 */
export const previewAdmin = (methods: Methods): AdminCapability => {
  const target: Record<PropertyKey, unknown> = { ...methods, [Symbol.dispose]: () => {} }
  return new Proxy(target, {
    get: (own, key) => {
      if (key in own) return own[key]
      // Not a promise, and nothing else a symbol asks after.
      if (key === 'then' || typeof key === 'symbol') return undefined
      return () => Promise.reject(new Error(`The preview can’t ${String(key)}.`))
    },
  }) as unknown as AdminCapability
}

/** A while, as a call over the connection takes. */
export const previewDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 600))

/** A promise that never settles, for a part shown as it loads. */
export const never = <T,>() => new Promise<T>(() => {})
