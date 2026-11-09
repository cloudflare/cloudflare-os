import { Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { Check, Info, Link as LinkIcon, Prohibit, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import Avatar from '../../components/Avatar'
import { roundButtonClass } from '../../components/RoundButton'
import ObserverConfigModal from '../../ObserverConfigModal'
import { accessRequestText, missingSourceLine } from './accessRequest'
import ResourceList from './ResourceList'
import type { SourceRow, SourceStatus, useExplore } from './useExplore'

const PRIMARY = 'inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3.5 text-[13px] font-medium text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40'

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
        <button type="button" className={roundButtonClass('pill')} onClick={explore.close}>Not now</button>
        <button
          type="button"
          className={PRIMARY}
          autoFocus
          onClick={() => void explore.continueWithAccounts()}
          disabled={connecting}
        >
          {connecting && <Loader size="sm" />}
          {vendor ? `Continue with ${vendor}` : 'Continue'}
        </button>
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
        <button type="button" className={PRIMARY} autoFocus onClick={explore.startExploring}>
          Start using it
        </button>
      ) : (
        <>
          {phase.kind === 'failure' && phase.missing.length > 0 && (
            <button type="button" className={roundButtonClass('pill')} onClick={copyRequest}>
              <LinkIcon size={14} />
              Copy access request
            </button>
          )}
          <button type="button" className={PRIMARY} autoFocus onClick={explore.close}>Done</button>
        </>
      )
    }
  }

  return (
    <Dialog.Root open disablePointerDismissal onOpenChange={open => { if (!open) explore.close() }}>
      <Dialog className="responsive-dialog !z-[1000] flex !w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-3xl bg-kumo-base p-0" size="base">
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="flex min-w-0 flex-col gap-1">
            <Dialog.Title className="text-[15px] font-medium leading-[18px] text-kumo-default">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description className="text-[13px] leading-[18px] text-kumo-subtle">{description}</Dialog.Description>
            )}
          </div>
          <Dialog.Close
            aria-label="Close"
            render={props => (
              <button {...props} type="button" aria-label="Close"
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default">
                <X size={14} />
              </button>
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
