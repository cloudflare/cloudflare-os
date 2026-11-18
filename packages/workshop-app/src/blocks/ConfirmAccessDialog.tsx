import { ArrowClockwiseIcon, CheckCircleIcon, PlusIcon, WarningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ListGroup } from './ListGroup'

/** One protected resource, as the dialog asks about it. */
export type ConfirmAccessRow = {
  key: string
  title: string
  service: { name: string; logoUrl?: string; color?: string }
  /** The user's accounts at its service, by the name they know each by. */
  accounts: { id: number; name: string; expired: boolean }[]
  /** The one chosen, by id. */
  chosen?: number
  /** The one chosen will do: signed in, given the access it needs, and not the one just refused. */
  ready: boolean
  /** The account the overseer just refused for it, and why, in its own words. */
  refusal?: { account: string; reason: string }
  /**
   * What would make the one chosen do: being given the access it needs (`grant`), or being signed
   * in to again (`reconnect`), which for one that was refused while signed in is only worth a try.
   */
  fix?: { kind: 'grant' | 'reconnect'; worthATry?: boolean; pending: boolean; onSelect: () => void }
  /** Connects an account at its service, or another one. Absent for a service that sets itself up. */
  connect?: { pending: boolean; onSelect: () => void }
}

export type ConfirmAccessDialogProps = {
  open: boolean
  /** What is being opened, as a sentence names it: "this workspace", "this gadget". */
  what: string
  /** Asked again, for those that could not be confirmed with the accounts chosen. */
  again?: boolean
  /** The resources, undefined while the accounts and services are read. */
  rows?: ConfirmAccessRow[]
  /** Why the last thing asked for, connecting an account, say, did not go through. */
  problem?: string
  onChoose: (key: string, accountId: number) => void
  /** Confirms with the accounts chosen, once each will do. */
  onConfirm: () => void
  /** Doesn't, which leaves it unopened. */
  onCancel: () => void
}

const FIX_WORDS = {
  grant: { idle: 'Give the access needed to confirm it', pending: 'Asking for access…' },
  reconnect: { idle: 'Sign in to it again', pending: 'Signing in…' },
}

const Row = ({ row, onChoose }: { row: ConfirmAccessRow; onChoose: ConfirmAccessDialogProps['onChoose'] }) => {
  const { title, service, accounts, chosen, ready, refusal, fix, connect } = row
  const only = accounts.length === 1 ? accounts[0] : undefined
  return (
    <div className="flex flex-col gap-2 rounded-2xl p-3 text-base">
      <div className="flex items-center gap-3">
        <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} small />
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate font-medium text-kumo-default">{title}</span>
          <span className="truncate text-kumo-subtle">{only ? `${service.name} · ${only.name}` : service.name}</span>
        </span>
        {ready && !refusal && <CheckCircleIcon aria-label="Ready" weight="fill" className="size-5 shrink-0 text-kumo-success" />}
        {accounts.length === 0 && connect && (
          <Button variant="primary" icon={PlusIcon} disabled={connect.pending} onClick={connect.onSelect} className="shrink-0">
            {connect.pending ? 'Connecting…' : `Connect ${service.name}`}
          </Button>
        )}
      </div>
      {/* Its own words, the service's or the overseer's, as they are. */}
      {refusal && (
        <p role="note" className="flex items-start gap-2 rounded-xl bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-default">
          <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kumo-warning" />
          <span className="min-w-0"><span className="font-medium">{refusal.account}</span>: {refusal.reason}</span>
        </p>
      )}
      {(accounts.length > 1 || fix || (accounts.length > 0 && connect)) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ps-13">
          {accounts.length > 1 && (
            <Select
              aria-label={`Account for ${title}`}
              placeholder={`Choose a ${service.name} account`}
              value={chosen === undefined ? '' : String(chosen)}
              options={accounts.map(({ id, name, expired }) => ({ id: String(id), label: expired ? `${name} (signed out)` : name }))}
              onValueChange={(id) => onChoose(row.key, Number(id))}
            />
          )}
          {fix && (
            <button
              type="button"
              disabled={fix.pending}
              onClick={fix.onSelect}
              className={cn('flex items-center gap-1.5 text-sm hover:underline disabled:opacity-60', fix.worthATry ? 'text-kumo-subtle' : 'text-kumo-warning')}
            >
              {fix.pending ? <ArrowClockwiseIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" /> : <WarningIcon aria-hidden="true" className="size-3.5" />}
              {fix.pending ? FIX_WORDS[fix.kind].pending : FIX_WORDS[fix.kind].idle}
            </button>
          )}
          {accounts.length > 0 && connect && (
            <button type="button" disabled={connect.pending} onClick={connect.onSelect} className="text-sm text-kumo-subtle hover:text-kumo-default disabled:opacity-60">
              {connect.pending ? 'Connecting…' : 'Use another account'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * What someone a workspace or gadget was shared with confirms before it opens: that their own
 * accounts can see what it reads, as whoever shared it could. Each protected resource once, however
 * many of its connections read it, under its service's logo, with the account to show it with:
 * the one they have there, a choice of those they have, or the way to connect one, and what would
 * make the one chosen do, where it would not. Asked again, it says why each was refused. Put away
 * any other way than confirming, it is cancelled, which leaves it unopened.
 */
export const ConfirmAccessDialog = ({ open, what, again = false, rows, problem, onChoose, onConfirm, onCancel }: ConfirmAccessDialogProps) => (
  <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
    <header className="flex flex-col gap-1 p-6 pb-4 leading-snug">
      <Dialog.Title className="text-lg font-medium text-kumo-default">{again ? 'Confirm your access again' : 'Confirm your access'}</Dialog.Title>
      <Dialog.Description className="text-sm text-pretty text-kumo-subtle">
        {again
          ? `Some of what ${what} reads couldn’t be confirmed with the accounts chosen. Sign in again, choose another account, or ask whoever shared it for access.`
          : `To open ${what}, confirm that your own accounts can see what it reads.`}
      </Dialog.Description>
    </header>
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-1">
      {rows
        ? <ListGroup label="Protected resources">{rows.map((row) => <Row key={row.key} row={row} onChoose={onChoose} />)}</ListGroup>
        : <p role="status" className="appears-late grid min-h-24 place-items-center text-base text-kumo-subtle">Loading your accounts…</p>}
    </div>
    <footer className="flex flex-col gap-3 p-6">
      {problem && <Banner title={problem} />}
      <div className="flex items-center justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!rows || !rows.every(({ ready }) => ready)} onClick={onConfirm}>
          {again ? 'Confirm again' : 'Confirm and open'}
        </Button>
      </div>
    </footer>
  </Dialog>
)
