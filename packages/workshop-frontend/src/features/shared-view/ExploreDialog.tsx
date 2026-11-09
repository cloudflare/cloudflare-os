import { Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { Check, Info, Link as LinkIcon, Prohibit, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import Avatar from '../../components/Avatar'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import ObserverConfigModal from '../../ObserverConfigModal'
import { accessRequestText, missingSourceLine } from './accessRequest'
import ResourceList from './ResourceList'
import type { SourceRow, SourceStatus, useExplore } from './useExplore'

type Props = {
  explore: ReturnType<typeof useExplore>
  authenticatedApi: RpcStub<AuthenticatedApi>
  ownerName: string
  appName: string
}

const Status = ({ status }: { status: SourceStatus }) => {
  if (status === 'checking') {
    return (
      <span className="flex items-center gap-1.5 font-medium text-kumo-inactive">
        <span aria-hidden className="shared-view-spin" />
        Checking
      </span>
    )
  }
  return status === 'ok' ? (
    <span className="flex items-center gap-1 font-medium text-kumo-success">
      <Check aria-hidden size={12} weight="bold" />
      Has access
    </span>
  ) : (
    <span className="flex items-center gap-1 font-medium text-kumo-danger">
      <Prohibit aria-hidden size={12} weight="bold" />
      No access
    </span>
  )
}

const Sources = ({ rows }: { rows: SourceRow[] }) => (
  <ResourceList
    label="What this gadget uses"
    fold={false}
    items={rows.map(row => ({
      key: row.gatekeeperId,
      title: row.resource,
      vendorName: row.vendorName,
      logoUrl: row.logoUrl,
      trailing: row.status && <Status status={row.status} />,
    }))}
  />
)

// "GitHub and Google", "GitHub, Google and Slack".
const listOf = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** One name for the sign-in, when every source goes through the same vendor. */
const soleVendor = (rows: SourceRow[]) => {
  const names = new Set(rows.map(row => row.vendorName))
  return names.size === 1 ? [...names][0] : undefined
}

/**
 * Use it live: one dialog from the invitation to its outcome. The source rows stay put
 * and gain a status each, so the viewer watches the same list resolve rather than a new screen.
 */
const ExploreDialog = ({ explore, authenticatedApi, ownerName, appName }: Props) => {
  const toasts = useKumoToastManager()
  const { phase, rows, settled, connecting, picker, accountLabel } = explore
  if (phase.kind === 'closed') return null

  if (picker) {
    // Several accounts, an expired one or a scope to grant: the full picker makes that choice.
    return (
      <ObserverConfigModal
        needs={picker}
        authenticatedApi={authenticatedApi}
        onConfirm={explore.send}
        onCancel={explore.closePicker}
      />
    )
  }

  const vendor = soleVendor(rows)
  const account = accountLabel && (
    <span className="flex items-center gap-2 self-start rounded-full bg-kumo-tint py-1 pl-1.5 pr-2.5 text-[12px] text-kumo-subtle">
      <Avatar src={rows[0]?.logoUrl} size={18} />
      {accountLabel}
    </span>
  )
  // The outcome is announced once every row has resolved, never ahead of the rows themselves.
  const outcome = phase.kind === 'success' || phase.kind === 'failure'
  const title =
    phase.kind === 'intro' || phase.kind === 'waiting' ? `Use it live with ${ownerName}`
      : phase.kind === 'checking' || !settled ? 'Checking access'
        : phase.kind === 'success' ? "You're all set"
          : `You'll keep seeing ${ownerName}'s snapshot`

  const copyRequest = () => {
    if (phase.kind !== 'failure') return
    const text = accessRequestText(phase.missing, appName)
    const missingVendor = phase.missing[0]?.vendorName ?? vendor
    navigator.clipboard.writeText(text).then(
      () => toasts.add({ title: `Copied. Paste it to whoever manages your ${missingVendor} access.` }),
      () => toasts.add({ title: 'Could not copy the access request', variant: 'error' }),
    )
  }

  let description = null
  let body
  let footer = null
  if (phase.kind === 'waiting') {
    body = <div className="flex justify-center py-6"><Loader /></div>
  } else if (phase.kind === 'intro') {
    const vendors = [...new Set(rows.map(row => row.vendorName))]
    description = vendor
      ? `Sign in with ${vendor} to confirm access to:`
      : `Sign in to ${listOf(vendors)} to confirm access to:`
    body = (
      <>
        <Sources rows={rows} />
        <p className="text-xs leading-[18px] text-kumo-subtle">
          Only used to check access. It keeps running on {ownerName}'s connections.
        </p>
      </>
    )
    footer = (
      <>
        {/* Matches the primary's height, which the secondary tone doesn't. */}
        <WorkshopButton className="!h-9" onClick={explore.close}>Not now</WorkshopButton>
        <WorkshopButton
          tone="primary"
          autoFocus
          onClick={() => void explore.continueWithAccounts()}
          disabled={connecting}
          loading={connecting}
        >
          {vendor ? `Continue with ${vendor}` : 'Continue'}
        </WorkshopButton>
      </>
    )
  } else {
    body = (
      <>
        {account}
        <Sources rows={rows} />
        {outcome && settled && phase.kind === 'success' && (
          <p className="flex items-start gap-2 text-[13px] leading-5 text-kumo-subtle">
            <Check aria-hidden size={14} weight="bold" className="mt-0.5 shrink-0 text-kumo-success" />
            You can open everything this gadget uses.
          </p>
        )}
        {outcome && settled && phase.kind === 'failure' && (
          <p className="flex items-start gap-2 text-[13px] leading-5 text-kumo-subtle">
            <Info aria-hidden size={14} weight="bold" className="mt-0.5 shrink-0 text-kumo-danger" />
            <span>
              {phase.missing.length > 0 && (
                <span className="font-medium text-kumo-default">{missingSourceLine(phase.missing)} </span>
              )}
              Once someone gives you access, you can use it the next time you open the gadget.
            </span>
          </p>
        )}
      </>
    )
    if (outcome && settled) {
      footer = phase.kind === 'success' ? (
        <WorkshopButton tone="primary" autoFocus onClick={explore.startExploring}>
          Start using it
        </WorkshopButton>
      ) : (
        <>
          {phase.kind === 'failure' && phase.missing.length > 0 && (
            <WorkshopButton className="!h-9" icon={<LinkIcon size={14} />} onClick={copyRequest}>
              Copy access request
            </WorkshopButton>
          )}
          <WorkshopButton tone="primary" autoFocus onClick={explore.close}>Done</WorkshopButton>
        </>
      )
    }
  }

  return (
    <Dialog.Root open disablePointerDismissal onOpenChange={open => { if (!open) explore.close() }}>
      <Dialog className="responsive-dialog flex flex-col rounded-2xl! p-0" size="base">
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <Dialog.Title className="text-base font-medium leading-6 tracking-[-0.25px] text-kumo-default">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description className="text-sm text-kumo-subtle">{description}</Dialog.Description>
            )}
          </div>
          <Dialog.Close
            aria-label="Close"
            render={props => (
              <WorkshopIconButton {...props} aria-label="Close"><X size={16} /></WorkshopIconButton>
            )}
          />
        </div>
        <div className={`flex flex-col gap-3 px-5 pt-3 ${footer ? 'pb-4' : 'pb-5'}`}>{body}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-5 py-4">
            {footer}
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}

export default ExploreDialog
