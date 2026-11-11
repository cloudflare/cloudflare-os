// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AdminApi, AdminResourceVendor, AdminSettingsView } from '@gadgets/workshop-shared/api'

const { getAdminApi, addToast } = vi.hoisted(() => ({
  getAdminApi: vi.fn<() => Promise<unknown>>(),
  addToast: vi.fn<(toast: { title: string; variant: string }) => void>(),
}))
const authenticatedApi = { getAdminApi }
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi, isAdmin: true }) }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn<() => void>(), useSearch: () => ({ tab: 'gatekeepers' }),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))
vi.mock('./features/deployment-updates/probeRouterTag', () => ({ probeRouterTag: async () => null }))

import AdminPage from './AdminPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('refreshes all affected resources when an admin clears an unmatched legacy restriction', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const retired = 'https://example.com/retired/*'
  const current = [
    { resourceTypeId: 'repository', urlPattern: 'https://example.com/:repo', title: 'Repository',
      description: 'Read code', enabled: false },
    { resourceTypeId: 'issue', urlPattern: 'https://example.com/:repo/issues/:id', title: 'Issue',
      description: 'Read issues', enabled: false },
  ]
  const vendor = { vendorId: 'example', displayName: 'Example', enabled: true,
    autoProvisions: false, resources: [...current,
      { urlPattern: retired, title: 'Unavailable resource type', description: 'Old restriction', enabled: false }],
  } satisfies AdminResourceVendor
  const settings: AdminSettingsView = {
    signupsEnabled: true, userSearchEnabled: false, siteName: '', instanceInstructions: '',
    announcement: '', banner: { text: '', color: 'neutral' }, accentColor: '', formats: [],
    restrictedWebFetchHosts: [], restrictedWebFetchApprovals: false,
    adminAuditRetentionDays: { effective: 30, chosen: 30, min: 30 },
    resourceVendors: [vendor],
  }
  const getSettings = vi.fn<AdminApi['getSettings']>().mockResolvedValueOnce(settings).mockResolvedValue({ ...settings,
    resourceVendors: [{ ...vendor, resources: current.map(r => ({ ...r, enabled: true })) }],
  })
  const setResourceEnabled = vi.fn<AdminApi['setResourceEnabled']>(async () => {})
  getAdminApi.mockResolvedValue({ getSettings, setResourceEnabled, getUpdateStatus: async () => null })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const row = (title: string) => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(element => element.querySelector('p')?.textContent === title)!
  try {
    await act(async () => { root.render(<AdminPage />) })
    expect(row('Repository').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { row('Unavailable resource type').click() })
    expect(setResourceEnabled).toHaveBeenCalledWith('example', retired, true)
    expect(row('Unavailable resource type')).toBeUndefined()
    for (const title of ['Repository', 'Issue']) {
      expect(row(title).querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
    }
    expect(addToast).not.toHaveBeenCalled()
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    vi.unstubAllGlobals()
  }
})
