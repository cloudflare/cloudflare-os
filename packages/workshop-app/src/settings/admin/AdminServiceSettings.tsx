import { useState } from 'react'
import type { AdminResourceVendor, AdminSettingsView, AmbientGatekeeperMode } from '@gadgets/workshop-shared/api'
import { Select, SettingRow, SettingsCard, SettingsGroup, Switch } from '@gadgets/ui'
import { ServiceLogo } from '@/components/ServiceLogo'
import { useAttempt } from '../useAttempt'
import { AdminSettingsStatus } from './AdminSettingsStatus'
import { useAdminSettings } from './useAdminSettings'

const MODES: { id: AmbientGatekeeperMode; label: string; detail: string }[] = [
  { id: 'disabled', label: 'Off', detail: 'Off for everyone.' },
  { id: 'optional', label: 'Optional', detail: 'Off until someone adds it for themselves.' },
  { id: 'enabled', label: 'On for everyone', detail: 'On for everyone, without their adding it.' },
]

// What a resource type is known by to the server: its id, or for a restriction older than ids,
// the address it matches.
const resourceKey = ({ resourceTypeId, urlPattern }: { resourceTypeId?: string; urlPattern: string }) => resourceTypeId ?? urlPattern

// The settings with one service shown as it will be.
const vendorShown = (vendorId: string, shown: (vendor: AdminResourceVendor) => AdminResourceVendor) =>
  (view: AdminSettingsView): AdminSettingsView => ({ ...view, resourceVendors: view.resourceVendors.map((vendor) => vendor.vendorId === vendorId ? shown(vendor) : vendor) })

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`

/**
 * Which services the deployment offers, and which of each service's kinds of resource: a surface
 * to a service, its logo and name over its kinds, each switched on and off. A service whose
 * account is made for people without their connecting it (the Context Library) has no kinds, and
 * is off, there for whoever adds it, or on for everyone. Turning something off takes nothing away
 * that a gadget already has.
 */
export const AdminServiceSettings = () => {
  const { state, change, reload } = useAdminSettings()
  const { problem, attempt } = useAttempt()
  // What is being switched, by service and kind, until the server has answered.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  const whileBusy = async (key: string, action: () => Promise<unknown>) => {
    setBusy((current) => new Set(current).add(key))
    try {
      await action()
    } finally {
      setBusy((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const setEnabled = (vendor: AdminResourceVendor, enabled: boolean) => whileBusy(vendor.vendorId, () =>
    attempt(`turn ${vendor.displayName} ${enabled ? 'on' : 'off'}`, () => change(
      vendorShown(vendor.vendorId, (shown) => shown.autoProvisions ? shown : { ...shown, enabled }),
      (admin) => admin.setGatekeeperMode(vendor.vendorId, enabled ? 'enabled' : 'disabled'),
    )))

  const setMode = (vendor: AdminResourceVendor, mode: AmbientGatekeeperMode) => whileBusy(vendor.vendorId, () =>
    attempt(`change ${vendor.displayName}`, () => change(
      vendorShown(vendor.vendorId, (shown) => shown.autoProvisions ? { ...shown, ambientMode: mode } : shown),
      (admin) => admin.setGatekeeperMode(vendor.vendorId, mode),
    )))

  const setResource = (vendor: AdminResourceVendor, key: string, title: string, enabled: boolean) => whileBusy(`${vendor.vendorId}\u0000${key}`, () =>
    attempt(`turn ${title} ${enabled ? 'on' : 'off'}`, async () => {
      await change(
        vendorShown(vendor.vendorId, (shown) => shown.autoProvisions ? shown : { ...shown, resources: shown.resources.map((resource) => resourceKey(resource) === key ? { ...resource, enabled } : resource) }),
        (admin) => admin.setResourceEnabled(vendor.vendorId, key, enabled),
      )
      // One kind can bear on another's, or leave a restriction older than ids behind.
      await reload()
    }))

  return (
    <AdminSettingsStatus state={state}>
      {({ resourceVendors }) => (
        <>
          {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
          <SettingsGroup
            title="Services"
            description="What people can connect, and which kinds of resource of each. Turning one off doesn’t take away what a gadget already has."
            plain
          >
            {resourceVendors.length === 0 && (
              <SettingsCard>
                <p className="py-4 text-kumo-subtle">No services that can be set are installed on this deployment.</p>
              </SettingsCard>
            )}
            {resourceVendors.map((vendor) => {
              const logo = <ServiceLogo name={vendor.displayName} src={vendor.logo?.url} small />
              if (vendor.autoProvisions) {
                const mode = MODES.find(({ id }) => id === vendor.ambientMode) ?? MODES[1]
                return (
                  <SettingsCard key={vendor.vendorId}>
                    <SettingRow title={vendor.displayName} icon={logo} description={`Made for each person without connecting. ${mode.detail}`}>
                      <Select
                        aria-label={vendor.displayName}
                        value={mode.id}
                        options={MODES}
                        onValueChange={(next) => {
                          if (!busy.has(vendor.vendorId)) void setMode(vendor, next)
                        }}
                      />
                    </SettingRow>
                  </SettingsCard>
                )
              }
              return (
                <SettingsCard key={vendor.vendorId}>
                  <SettingRow
                    title={vendor.displayName}
                    icon={logo}
                    description={vendor.enabled ? undefined : `Off. Its ${plural(vendor.resources.length, 'kind')} of resource can’t be used until it is on.`}
                  >
                    <Switch aria-label={vendor.displayName} checked={vendor.enabled} busy={busy.has(vendor.vendorId)} onCheckedChange={(enabled) => void setEnabled(vendor, enabled)} />
                  </SettingRow>
                  {/* Hidden while it is off, as none of them can be used. */}
                  {vendor.enabled && vendor.resources.map((resource) => {
                    const key = resourceKey(resource)
                    return (
                      <SettingRow key={key} title={resource.title} description={resource.description}>
                        <Switch
                          aria-label={`${vendor.displayName}: ${resource.title}`}
                          checked={resource.enabled}
                          busy={busy.has(`${vendor.vendorId}\u0000${key}`)}
                          onCheckedChange={(enabled) => void setResource(vendor, key, resource.title, enabled)}
                        />
                      </SettingRow>
                    )
                  })}
                </SettingsCard>
              )
            })}
          </SettingsGroup>
        </>
      )}
    </AdminSettingsStatus>
  )
}
