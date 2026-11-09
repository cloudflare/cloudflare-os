import { Dialog, Switch } from '@cloudflare/kumo'
import { X, ShieldCheck } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import {
  AccountDescription,
  SupportedResource,
  VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'
import { roundButtonClass } from './RoundButton'

interface ConnectConnectorModalProps {
  open: boolean
  mode: 'connect' | 'manage'
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  logoUrl?: string
  color?: string
  // True for an auto-provisioning ("ambient") gatekeeper: confirming adds it directly (no OAuth
  // redirect), so the call-to-action reads "Add …" rather than "Continue to …".
  autoProvisions?: boolean
  onOpenChange: (open: boolean) => void
  connecting?: boolean
  onCancelConnect?: () => void
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
  supportedResources,
  logoUrl,
  color,
  autoProvisions = false,
  onOpenChange,
  connecting = false,
  onCancelConnect,
  onConfirm,
  accountDescription,
  credentialsValid = true,
  disconnecting = false,
  onDisconnect,
  grantedResourceUrlPatterns,
  onEnsureResources,
  ensuringResourceUrlPatterns = [],
}: ConnectConnectorModalProps) {
  const isManage = mode === 'manage'

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

  const accountDisplayName =
    accountDescription?.displayName ??
    accountDescription?.uniqueName ??
    'Connected'
  const accountLine = accountDescription?.uniqueName && accountDescription.uniqueName !== accountDisplayName
    ? `${accountDisplayName} · ${accountDescription.uniqueName}`
    : accountDisplayName

  const headerTitle = isManage
    ? vendorDescription.displayName
    : autoProvisions
    ? `Add ${vendorDescription.displayName}`
    : `Connect ${vendorDescription.displayName}`

  const busy = connecting || disconnecting

  const resourcesHeading = granular
    ? isManage ? 'What it can reach' : 'Choose what it can reach'
    : 'What it can do'

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (busy) return
        onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="responsive-dialog connect-connector-dialog !z-[1000] !top-[clamp(28px,8vh,80px)] !flex !max-h-[calc(100vh-clamp(28px,8vh,80px)-28px)] !w-[min(560px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden !rounded-[20px] bg-kumo-base p-0"
        size="lg"
      >
        <div className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-[12px] ring-1 ring-inset ring-kumo-line"
            style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
          >
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-5 object-contain" />
            ) : (
              <span className="text-sm font-semibold text-kumo-strong">{vendorDescription.displayName[0]}</span>
            )}
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <Dialog.Title className="text-[16px] font-medium leading-5 text-kumo-default">
              {headerTitle}
            </Dialog.Title>
            {isManage ? (
              <p className="mt-1 flex items-center gap-1.5 text-[13px] leading-4 text-kumo-subtle">
                <span className={`size-1.5 shrink-0 rounded-full ${credentialsValid ? 'bg-kumo-success' : 'bg-kumo-danger'}`} aria-hidden />
                <span className="truncate">
                  {!credentialsValid ? 'Sign-in expired. Reconnect it from the list.'
                    : accountLine === vendorDescription.displayName ? 'Connected' : accountLine}
                </span>
              </p>
            ) : vendorDescription.tagline && (
              <Dialog.Description className="mt-1 text-[13px] leading-4 text-kumo-subtle">
                {vendorDescription.tagline}
              </Dialog.Description>
            )}
          </div>
          <Dialog.Close
            render={(props) => (
              <button {...props} type="button" disabled={busy} aria-label="Close" className={roundButtonClass('icon', '!size-8 -mr-1 -mt-1 ring-0 hover:bg-kumo-tint')}>
                <X size={16} />
              </button>
            )}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {vendorDescription.description && (
            <p className="text-[14px] leading-5 text-kumo-default">{vendorDescription.description}</p>
          )}

          {supportedResources.length > 0 && (
            <div className="mt-5 flex flex-col gap-2">
              <h3 className="text-[13px] font-medium leading-4 text-kumo-subtle">{resourcesHeading}</h3>
              <ul className="flex flex-col rounded-[16px] bg-kumo-contrast/[0.03] p-1.5">
                {supportedResources.map((resource) => {
                  const grantable = Boolean(resource.grantable)
                  const granted = isManage && grantable && isGranted(resource.urlPattern)
                  const ensuring = ensuringResourceUrlPatterns.includes(resource.urlPattern)
                  const checked = grantable && (selected.has(resource.urlPattern) || ensuring)
                  const disabled = isManage && (granted || ensuring)
                  const icon = resource.icon?.url ?? logoUrl
                  return (
                    <li key={resource.urlPattern} className="flex items-center gap-3 rounded-[12px] px-2.5 py-2">
                      <span className="grid size-[25px] shrink-0 place-items-center text-kumo-default">
                        {icon ? <img src={icon} alt="" className="size-4 object-contain" /> : <ResourceIconGlyph />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-medium leading-[17px] text-kumo-default">{resource.title}</p>
                        <p className="mt-0.5 text-[13px] leading-4 text-kumo-subtle">{resource.description}</p>
                      </div>
                      {grantable && (
                        <Switch
                          size="sm"
                          className="shrink-0"
                          aria-label={isManage ? `Grant ${resource.title}` : `Enable ${resource.title}`}
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={(next) => toggleResource(resource.urlPattern, next)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {!autoProvisions && (
            <p className="mt-4 flex items-start gap-2 text-[13px] leading-[18px] text-kumo-subtle">
              <ShieldCheck size={16} className="mt-px shrink-0" />
              {isManage
                ? 'Gadgets reach only what you connect them to, and anyone you share with is checked first.'
                : `Each gadget sees only the ${vendorDescription.displayName} resources you connect to it, and anyone you share with is checked first.`}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-4">
          {isManage && confirmingDisconnect ? (
            <p className="mr-auto min-w-0 flex-1 text-[13px] leading-4 text-kumo-default">
              Disconnect {vendorDescription.displayName}? Gadgets using it lose access.
            </p>
          ) : isManage && hasPending ? (
            <p className="mr-auto min-w-0 flex-1 text-[13px] leading-4 text-kumo-subtle">
              {pendingPatterns.length} to add
            </p>
          ) : !isManage && granular && noneSelected ? (
            <p className="mr-auto min-w-0 flex-1 text-[13px] leading-4 text-kumo-subtle">
              Choose at least one to continue.
            </p>
          ) : null}
          {isManage ? (
            confirmingDisconnect ? (
              <>
                <button type="button" onClick={() => setConfirmingDisconnect(false)} disabled={disconnecting} className={SECONDARY}>
                  Cancel
                </button>
                <button type="button" onClick={handleDisconnect} disabled={disconnecting} className={DANGER}>
                  {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                </button>
              </>
            ) : hasPending ? (
              <>
                <button type="button" onClick={discardPending} disabled={ensuringBusy} className={SECONDARY}>
                  Cancel
                </button>
                <button type="button" onClick={handleAddResources} disabled={ensuringBusy} className={PRIMARY}>
                  {ensuringBusy ? 'Opening…' : `Continue to ${vendorDescription.displayName}`}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={handleDisconnect} disabled={disconnecting} className={`${SECONDARY} mr-auto !text-kumo-danger`}>
                  Disconnect
                </button>
                <Dialog.Close render={(props) => <button {...props} type="button" className={PRIMARY}>Done</button>} />
              </>
            )
          ) : (
            <>
              {connecting && onCancelConnect ? (
                <button type="button" onClick={onCancelConnect} className={SECONDARY}>Cancel connection</button>
              ) : (
                <Dialog.Close render={(props) => <button {...props} type="button" disabled={connecting} className={SECONDARY}>Cancel</button>} />
              )}
              <button type="button" onClick={handleConfirm} disabled={connecting || (granular && noneSelected)} className={PRIMARY}>
                {autoProvisions
                  ? connecting ? 'Adding…' : `Add ${vendorDescription.displayName}`
                  : connecting ? 'Opening…' : `Continue to ${vendorDescription.displayName}`}
              </button>
            </>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

const SECONDARY = roundButtonClass('pill')
const PRIMARY = 'inline-flex h-[34px] shrink-0 cursor-pointer items-center rounded-full bg-kumo-contrast px-3.5 text-[13px] font-medium leading-4 text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50'
const DANGER = 'inline-flex h-[34px] shrink-0 cursor-pointer items-center rounded-full bg-kumo-danger px-3.5 text-[13px] font-medium leading-4 text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50'

function ResourceIconGlyph() {
  const size = 14
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  )
}
