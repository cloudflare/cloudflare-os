import { Dialog, Switch } from '@cloudflare/kumo'
import { useT, localizeAccountDisplayName, localizeVendorDisplay, localizeSupportedResource } from '../i18n'

import { X, ShieldCheck } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

interface ConnectConnectorModalProps {
  open: boolean
  mode: 'connect' | 'manage'
  vendorDescription: VendorDescription
  vendorId?: string
  supportedResources: SupportedResource[]
  logoUrl?: string
  color?: string
  // True for an auto-provisioning ("ambient") gatekeeper: confirming adds it directly (no OAuth
  // redirect), so the call-to-action reads "Add …" rather than "Continue to …".
  autoProvisions?: boolean
  onOpenChange: (open: boolean) => void
  connecting?: boolean
  // Connect mode: invoked with the `urlPattern`s of the grantable resources the user chose to
  // enable. `undefined` means "enable everything" (no toggle was deselected), matching the
  // gatekeeper's default behavior.
  onConfirm?: (resourceUrlPatterns?: string[]) => void
  accountDescription?: AccountDescription
  credentialsValid?: boolean
  disconnecting?: boolean
  onDisconnect?: () => void
  grantedResourceUrlPatterns?: string[]
  // Manage mode: invoked to expand the grant to include the given resource `urlPattern`s.
  onEnsureResources?: (resourceUrlPatterns: string[]) => void
  // Resource `urlPattern`s currently being granted (shows a busy state on the relevant toggle).
  ensuringResourceUrlPatterns?: string[]
}

export default function ConnectConnectorModal({
  open,
  mode,
  vendorDescription,
  vendorId,
  supportedResources,
  logoUrl,
  color,
  autoProvisions = false,
  onOpenChange,
  connecting = false,
  onConfirm,
  accountDescription,
  credentialsValid = true,
  disconnecting = false,
  onDisconnect,
  grantedResourceUrlPatterns,
  onEnsureResources,
  ensuringResourceUrlPatterns = [],
}: ConnectConnectorModalProps) {
  const t = useT()
  const isManage = mode === 'manage'
  // Localize known vendor label, tagline, and long description; server metadata remains fallback.
  const vendorDisplay = localizeVendorDisplay(t, {
    id: vendorId,
    displayName: vendorDescription.displayName,
    tagline: vendorDescription.tagline,
    description: vendorDescription.description,
  })
  const vendorName = vendorDisplay.displayName

  // Resource types the user can individually enable/disable at connect time. Resources without
  // `grantable` are shown for information but aren't toggleable -- the account grant covers them
  // whenever it's connected.
  const grantableResources = useMemo(
    () => supportedResources.filter((r) => r.grantable),
    [supportedResources],
  )
  const granular = grantableResources.length > 0
  const grantableKey = grantableResources.map((r) => r.urlPattern).join(',')

  const isGranted = (urlPattern: string) =>
    grantedResourceUrlPatterns === undefined ||
    grantedResourceUrlPatterns.includes(urlPattern)

  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setConfirmingDisconnect(false)
  }, [open])

  const grantedKey = (grantedResourceUrlPatterns ?? []).join(',')
  useEffect(() => {
    if (!open) return
    if (isManage) {
      setSelected(
        new Set(
          grantableResources
            .map((r) => r.urlPattern)
            .filter((p) => isGranted(p)),
        ),
      )
    } else {
      setSelected(new Set(grantableResources.map((r) => r.urlPattern)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isManage, grantableKey, grantedKey])

  const noneSelected = granular && selected.size === 0

  const pendingPatterns = isManage
    ? [...selected].filter((p) => !isGranted(p))
    : []
  const hasPending = pendingPatterns.length > 0

  function toggleResource(urlPattern: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(urlPattern)
      else next.delete(urlPattern)
      return next
    })
  }

  function handleAddResources() {
    if (hasPending) onEnsureResources?.(pendingPatterns)
  }

  function discardPending() {
    setSelected(
      new Set(
        grantableResources.map((r) => r.urlPattern).filter((p) => isGranted(p)),
      ),
    )
  }

  const ensuringBusy = ensuringResourceUrlPatterns.length > 0

  function handleConfirm() {
    if (!onConfirm) return
    if (granular) {
      const allSelected = selected.size === grantableResources.length
      onConfirm(allSelected ? undefined : [...selected])
    } else {
      onConfirm(undefined)
    }
  }

  function handleDisconnect() {
    if (!confirmingDisconnect) {
      setConfirmingDisconnect(true)
      return
    }
    onDisconnect?.()
  }

  const accountDisplayName = localizeAccountDisplayName(
    t,
    accountDescription?.displayName ?? accountDescription?.uniqueName,
  )

  const headerTitle = isManage
    ? vendorName
    : t('connectors.connect', { name: vendorName })

  const headerSubline = isManage ? (
    <div className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          credentialsValid ? 'bg-kumo-success' : 'bg-kumo-danger'
        }`}
        aria-hidden
      />
      <span className="truncate">
        {credentialsValid
          ? accountDescription?.uniqueName
            ? `${accountDisplayName} / ${accountDescription.uniqueName}`
            : accountDisplayName
          : t('connectors.credentialsExpiredReconnect')}
      </span>
    </div>
  ) : (
    vendorDisplay.tagline && (
      <Dialog.Description className="mt-0.5 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
        {vendorDisplay.tagline}
      </Dialog.Description>
    )
  )

  const busy = connecting || disconnecting

  // Resource icon helper shared by every resource row.
  function resourceIcon(resource?: SupportedResource) {
    const icon = resource?.icon?.url ?? logoUrl
    return (
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-kumo-strong"
        style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
      >
        {icon ? (
          <img src={icon} alt="" className="h-4 w-4 object-contain" />
        ) : (
          <ResourceIconGlyph />
        )}
      </div>
    )
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (busy) return
        onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="responsive-dialog connect-connector-dialog !z-[1000] !top-[clamp(28px,8vh,80px)] !flex !max-h-[calc(100vh-clamp(28px,8vh,80px)-28px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0"
        size="lg"
      >
        <div className="shrink-0 flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
            >
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-5 w-5 object-contain" />
              ) : (
                <span className="text-sm font-semibold text-kumo-strong">
                  {vendorName[0] || '?'}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                {headerTitle}
              </Dialog.Title>
              {headerSubline}
            </div>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} disabled={busy} aria-label={t('common.close')}>
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="new-gatekeeper-scroll-balanced min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {vendorDisplay.description && (
            <p className="text-[13px] leading-[19px] font-normal tracking-[-0.25px] text-kumo-default">
              {vendorDisplay.description}
            </p>
          )}

          {supportedResources.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-[12px] leading-4 font-semibold uppercase tracking-[0.6px] text-kumo-inactive">
                {granular
                  ? isManage
                    ? t('connectors.resources')
                    : t('connectors.resourcesToEnable')
                  : t('connectors.whatCanDo')}
              </h3>
              <ul className="space-y-2">
                {supportedResources.map((resource) => {
                  const grantable = Boolean(resource.grantable)
                  const granted = isManage && grantable && isGranted(resource.urlPattern)
                  const ensuring = ensuringResourceUrlPatterns.includes(
                    resource.urlPattern,
                  )
                  const checked =
                    grantable &&
                    (selected.has(resource.urlPattern) || ensuring)
                  const disabled = isManage && (granted || ensuring)
                  const localizedResource = localizeSupportedResource(t, resource)
                  return (
                    <li
                      key={resource.urlPattern}
                      className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5"
                    >
                      {resourceIcon(resource)}
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                          {localizedResource.title}
                        </p>
                        <p className="mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                          {localizedResource.description}
                        </p>
                      </div>
                      {grantable && (
                        <Switch
                          size="sm"
                          className="shrink-0"
                          aria-label={
                            isManage
                              ? t('connectors.grantResource', { title: localizedResource.title })
                              : t('connectors.enableResource', { title: localizedResource.title })
                          }
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={(next) =>
                            toggleResource(resource.urlPattern, next)
                          }
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {!isManage && !autoProvisions && (
            <div
              className="relative mt-5 overflow-hidden rounded-lg border border-kumo-line px-4 py-3"
              style={{
                background:
                  'linear-gradient(180deg, rgba(255, 72, 1, 0.04) 0%, rgba(255, 72, 1, 0.02) 100%)',
              }}
            >
              <div className="flex items-start gap-3">
                <ShieldCheck
                  size={18}
                  className="mt-0.5 shrink-0 text-kumo-brand"
                  weight="duotone"
                />
                <div className="text-[12px] leading-[17px] font-normal tracking-[-0.2px] text-kumo-default">
                  <span className="font-medium">
                    {t('connectors.sitsBetween', { name: vendorName })}
                  </span>{' '}
                  <span className="text-kumo-subtle">
                    {t('connectors.sitsBetweenBody')}
                  </span>
                </div>
              </div>
            </div>
          )}

          {isManage && (
            <div className="mt-5 rounded-lg border border-kumo-line bg-kumo-elevated px-4 py-3 text-[12px] leading-[17px] font-normal tracking-[-0.2px] text-kumo-subtle">
              {t('connectors.sharedAccountBody')}
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-base px-5 py-3">
          {isManage && confirmingDisconnect ? (
            <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-default">
              {t('connectors.disconnectConfirm', { name: vendorName })}
            </p>
          ) : isManage && hasPending ? (
            <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {pendingPatterns.length === 1
                ? t('connectors.pendingResourceToAdd', { count: pendingPatterns.length })
                : t('connectors.pendingResourcesToAdd', { count: pendingPatterns.length })}
            </p>
          ) : !isManage && granular && noneSelected ? (
            <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {t('connectors.selectResourceToContinue')}
            </p>
          ) : (
            <span aria-hidden />
          )}
          <div className="flex items-center gap-2">
            {isManage ? (
              <>
                {confirmingDisconnect ? (
                  <>
                    <WorkshopButton
                      onClick={() => setConfirmingDisconnect(false)}
                      disabled={disconnecting}
                      className="!h-9"
                    >
                      {t('connectors.cancel')}
                    </WorkshopButton>
                    <WorkshopButton
                      tone="danger"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="!h-9 min-w-[140px]"
                    >
                      {disconnecting
                        ? t('connectors.disconnecting')
                        : t('connectors.yesDisconnect')}
                    </WorkshopButton>
                  </>
                ) : hasPending ? (
                  <>
                    <WorkshopButton onClick={discardPending} disabled={ensuringBusy} className="!h-9">
                      {t('connectors.cancel')}
                    </WorkshopButton>
                    <WorkshopButton
                      tone="primary"
                      onClick={handleAddResources}
                      disabled={ensuringBusy}
                      className="min-w-[140px]"
                    >
                      {ensuringBusy
                        ? t('connectors.opening')
                        : t('connectors.continueTo', { name: vendorName })}
                    </WorkshopButton>
                  </>
                ) : (
                  <>
                    <Dialog.Close
                      render={(props) => (
                        <WorkshopButton {...props} className="!h-9">
                          {t('connectors.close')}
                        </WorkshopButton>
                      )}
                    />
                    <WorkshopButton
                      tone="danger"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="!h-9"
                    >
                      {t('connectors.disconnect')}
                    </WorkshopButton>
                  </>
                )}
              </>
            ) : (
              <>
                <Dialog.Close
                  render={(props) => (
                    <WorkshopButton {...props} disabled={connecting} className="!h-9">
                      {t('connectors.cancel')}
                    </WorkshopButton>
                  )}
                />
                <WorkshopButton
                  tone="primary"
                  onClick={handleConfirm}
                  disabled={connecting || (granular && noneSelected)}
                  className="min-w-[140px]"
                >
                  {autoProvisions
                    ? connecting
                      ? t('connectors.adding')
                      : t('connectors.add', { name: vendorName })
                    : connecting
                    ? t('connectors.opening')
                    : t('connectors.continueTo', { name: vendorName })}
                </WorkshopButton>
              </>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function ResourceIconGlyph() {
  const size = 14
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  )
}
