import { useState, type ReactNode } from 'react'
import { CheckIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ServiceLogo } from '@/components/ServiceLogo'

/** One of the user's accounts on the service, to connect with. */
export type SetUpConnectionAccount = {
  id: number
  /** Which account it is, as the user would know it: "octocat", "ada@example.com". */
  name: string
  /** Its sign-in has expired, so it must be reconnected first. */
  expired?: boolean
}

export type SetUpConnectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  service: { name: string; logoUrl?: string; color?: string }
  /** What the agent asked for: the kind of resource, or its address. */
  resource?: string
  /** Why the agent asked for it, in its own words. */
  reason: string
  /** The user's accounts on the service; none given, they are still loading. */
  accounts?: SetUpConnectionAccount[]
  selectedAccountId?: number
  onSelectAccount: (id: number) => void
  /**
   * Connects an account (another, when there are some), or reconnects the expired one chosen, in
   * a window of the service's. Resolves to whether it went ahead; the dialog then waits for the
   * account, which arrives in `accounts`.
   */
  onConnectAccount: () => Promise<boolean>
  onReconnect: (id: number) => Promise<boolean>
  /** The account chosen has not given access to this kind of resource: asks it to, likewise. */
  onGrant?: () => Promise<boolean>
  /** The service's own form for which resource it is, once there is an account to choose it with. */
  configurator?: ReactNode
  /** What the form has chosen can be connected. */
  ready: boolean
  /** Connects what was chosen and hands it to the agent, which resolves once it has. */
  onAccept: () => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What an agent's connection request asks for, set up (`ConnectionRequestCard`'s Set up): the
 * service's account to use, connecting one first where there is none, then which resource, in the
 * service's own form, filled in with as much as the agent knew. Each step that goes on in a window
 * of the service's waits for it, saying so, and can open it again.
 */
export const SetUpConnectionDialog = ({
  open, onOpenChange, service, resource, reason, accounts, selectedAccountId, onSelectAccount,
  onConnectAccount, onReconnect, onGrant, configurator, ready, onAccept,
}: SetUpConnectionDialogProps) => {
  const [pending, setPending] = useState<'connect' | 'reconnect' | 'grant' | 'accept'>()
  // A window of the service's was opened for this, and is waited for.
  const [waitingFor, setWaitingFor] = useState<'connect' | 'reconnect' | 'grant'>()
  const [problem, setProblem] = useState<string>()
  const selected = accounts?.find(({ id }) => id === selectedAccountId)
  // What was waited for has come: an account, its sign-in, or access.
  const known = accounts?.map(({ id, expired }) => `${id}${expired ? '!' : ''}`).join() ?? ''
  const [waitedOver, setWaitedOver] = useState({ known, onGrant: onGrant !== undefined })
  if (waitedOver.known !== known || waitedOver.onGrant !== (onGrant !== undefined)) {
    setWaitedOver({ known, onGrant: onGrant !== undefined })
    setWaitingFor(undefined)
  }

  const run = async (what: NonNullable<typeof pending>, action: () => Promise<boolean>) => {
    setProblem(undefined)
    setPending(what)
    try {
      const went = await action()
      if (went && what !== 'accept') setWaitingFor(what)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(undefined)
    }
  }

  const none = accounts?.length === 0
  const opening = (what: NonNullable<typeof waitingFor>, label: string) =>
    pending === what ? 'Opening…' : waitingFor === what ? 'Open again' : label

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (pending !== 'accept') onOpenChange(next) }}
      size="lg"
      title={(
        <span className="flex items-center gap-3">
          <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} size="lg" />
          Connect {service.name}
        </span>
      )}
      description={resource ? `The agent asked for ${resource}.` : undefined}
      footer={(
        <>
          <Button disabled={pending === 'accept'} onClick={() => onOpenChange(false)}>Cancel</Button>
          {none ? (
            <Button variant="primary" disabled={pending !== undefined} onClick={() => void run('connect', onConnectAccount)}>
              {opening('connect', `Continue to ${service.name}`)}
            </Button>
          ) : (
            <Button variant="primary" disabled={!ready || pending !== undefined || !selected || selected.expired} onClick={() => void run('accept', onAccept)}>
              {pending === 'accept' ? 'Connecting…' : 'Connect'}
            </Button>
          )}
        </>
      )}
    >
      <blockquote className="rounded-2xl bg-kumo-tint px-4 py-3 text-base/5 text-kumo-default">{reason}</blockquote>
      {accounts === undefined && <p role="status" className="appears-late text-base text-kumo-subtle">Loading your accounts…</p>}
      {none && (
        <p className="text-base/5 text-kumo-subtle">
          Connect your {service.name} account first. You choose what the agent can reach once it is connected.
        </p>
      )}
      {accounts && accounts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="px-1 text-sm font-medium text-kumo-subtle">Account</h3>
          <div role="radiogroup" aria-label="Account" className="flex flex-col rounded-2xl bg-kumo-tint p-1.5">
            {accounts.map((account) => {
              const checked = account.id === selectedAccountId
              return (
                <div key={account.id} className="flex items-center gap-2 rounded-xl pr-1.5 hover:bg-kumo-contrast/5">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => onSelectAccount(account.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2 pl-2.5 text-left text-base"
                  >
                    <span className={cn('grid size-5 shrink-0 place-items-center rounded-full ring-1 ring-kumo-line ring-inset', checked && 'bg-kumo-contrast text-kumo-inverse ring-0')}>
                      {checked && <CheckIcon weight="bold" className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{account.name}</span>
                    {account.expired && <span className="shrink-0 text-kumo-danger">Sign-in expired</span>}
                  </button>
                  {account.expired && checked && (
                    <Button disabled={pending !== undefined} onClick={() => void run('reconnect', () => onReconnect(account.id))}>
                      {opening('reconnect', 'Reconnect')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          <Button variant="ghost" className="self-start text-kumo-subtle" disabled={pending !== undefined} onClick={() => void run('connect', onConnectAccount)}>
            {opening('connect', 'Use another account')}
          </Button>
        </section>
      )}
      {selected && !selected.expired && onGrant && (
        <div className="flex items-center gap-3 rounded-2xl bg-kumo-tint px-4 py-3">
          <p className="min-w-0 flex-1 text-base/5 text-kumo-default">
            This account hasn’t given access to {resource ?? 'this'} yet.
          </p>
          <Button variant="primary" disabled={pending !== undefined} onClick={() => void run('grant', onGrant)}>
            {opening('grant', 'Give access')}
          </Button>
        </div>
      )}
      {selected && !selected.expired && !onGrant && configurator}
      {waitingFor && (
        <p role="status" className="appears text-base/5 text-kumo-default">
          Finish in the {service.name} window. If you closed it, open it again.
        </p>
      )}
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
