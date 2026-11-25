import { useState } from 'react'
import type { AdminSettingsView } from '@gadgets/workshop-shared/api'
import { Select } from '@gadgets/ui'
import { AdminCapabilityProvider } from '@/settings/admin/AdminContext'
import { AdminAccessSettings } from '@/settings/admin/AdminAccessSettings'
import { AdminGeneralSettings } from '@/settings/admin/AdminGeneralSettings'
import { AdminServiceSettings } from '@/settings/admin/AdminServiceSettings'
import { never, previewAdmin, previewDelay, PREVIEW_ADMIN_SETTINGS } from './adminPreview'
import { Section } from './Section'

const VENDORS: AdminSettingsView['resourceVendors'] = [
  {
    vendorId: 'google',
    displayName: 'Google',
    autoProvisions: false,
    enabled: true,
    resources: [
      { resourceTypeId: 'drive-file', urlPattern: 'https://drive.google.com/*', title: 'Drive files', description: 'A file in Google Drive, read or written.', enabled: true },
      { resourceTypeId: 'calendar', urlPattern: 'https://calendar.google.com/*', title: 'Calendars', description: 'Events on a calendar, read or added to.', enabled: false },
    ],
  },
  { vendorId: 'github', displayName: 'GitHub', autoProvisions: false, enabled: false, resources: [{ resourceTypeId: 'repo', urlPattern: 'https://github.com/*', title: 'Repositories', description: 'A repository’s code and issues.', enabled: true }] },
  { vendorId: 'context', displayName: 'Context Library', autoProvisions: true, ambientMode: 'optional' },
]

type Shown = 'ready' | 'loading' | 'failed' | 'refusing'

/** A fake of the server's settings, kept as it is changed, which refuses every change while `refusing`. */
const fakeAdmin = (shown: Shown) => {
  let view: AdminSettingsView = { ...PREVIEW_ADMIN_SETTINGS, resourceVendors: VENDORS }
  const set = (change: Partial<AdminSettingsView>) => async () => {
    await previewDelay()
    if (shown === 'refusing') throw new Error('The preview refuses every change.')
    view = { ...view, ...change }
  }
  return previewAdmin({
    getSettings: () => shown === 'loading' ? never() : shown === 'failed' ? Promise.reject(new Error('The server couldn’t be reached.')) : previewDelay().then(() => view),
    setSignupsEnabled: (signupsEnabled) => set({ signupsEnabled })(),
    setUserSearchEnabled: (userSearchEnabled) => set({ userSearchEnabled })(),
    setSiteName: (siteName) => set({ siteName })(),
    setSiteLogo: async (data) => {
      await set({})()
      return data ? { url: URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'image/png' })) } : undefined
    },
    setAccentColor: (accentColor) => set({ accentColor })(),
    setBanner: (text, color) => set({ banner: { text, color } })(),
    setAnnouncement: (announcement) => set({ announcement })(),
    setInstanceInstructions: (instanceInstructions) => set({ instanceInstructions })(),
    setRestrictedWebFetchHosts: async (hosts) => {
      await set({ restrictedWebFetchHosts: hosts })()
      return hosts
    },
    setRestrictedWebFetchApprovals: (restrictedWebFetchApprovals) => set({ restrictedWebFetchApprovals })(),
    setGatekeeperMode: (vendorId, mode) => set({ resourceVendors: view.resourceVendors.map((vendor) => vendor.vendorId !== vendorId ? vendor : vendor.autoProvisions ? { ...vendor, ambientMode: mode } : { ...vendor, enabled: mode !== 'disabled' }) })(),
    setResourceEnabled: (vendorId, key, enabled) => set({ resourceVendors: view.resourceVendors.map((vendor) => vendor.vendorId !== vendorId || vendor.autoProvisions ? vendor : { ...vendor, resources: vendor.resources.map((resource) => (resource.resourceTypeId ?? resource.urlPattern) === key ? { ...resource, enabled } : resource) }) })(),
  })
}

const PARTS = { general: AdminGeneralSettings, services: AdminServiceSettings, access: AdminAccessSettings }

/** The deployment's General, Services and Access settings, over a fake server, in each of their states. */
export const AdminSettingsPreview = () => {
  const [part, setPart] = useState<keyof typeof PARTS>('general')
  const [shown, setShown] = useState<Shown>('ready')
  const Part = PARTS[part]
  return (
    <Section title="Admin settings: General (a site name kept on Enter, a logo uploaded or restored from its tile’s menu, an accent from swatches or any color, the banner and the top-bar notice saved or discarded once written, with their length, agent instructions, and trusted hosts added and removed), Services (a service with its kinds, one that is off with its kinds hidden, and one made for everyone, Off, Optional or On), Access (two switches); each as it loads, when it couldn’t be read, and with every change refused">
      <div className="flex w-full max-w-3xl flex-col gap-6">
        <div className="flex flex-wrap gap-4">
          <Select aria-label="Part" value={part} onValueChange={setPart} options={[{ id: 'general', label: 'General' }, { id: 'services', label: 'Services' }, { id: 'access', label: 'Access' }]} />
          <Select<Shown> aria-label="State" value={shown} onValueChange={setShown} options={[{ id: 'ready', label: 'Ready' }, { id: 'loading', label: 'Loading' }, { id: 'failed', label: 'Couldn’t be read' }, { id: 'refusing', label: 'Refusing changes' }]} />
        </div>
        {/* A fresh server for each, as a part reads the settings as it opens. */}
        <AdminCapabilityProvider key={`${part}-${shown}`} admin={fakeAdmin(shown)}>
          <div className="flex flex-col gap-12">
            <Part />
          </div>
        </AdminCapabilityProvider>
      </div>
    </Section>
  )
}
