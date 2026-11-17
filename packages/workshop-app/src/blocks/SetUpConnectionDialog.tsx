import { useState, type ReactNode } from 'react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { ServiceDialogHeader } from './ServiceDialogHeader'

/** One of the user's accounts on the service, to connect with. */
export type SetUpConnectionAccount = {
  id: number
  /** Which account it is, as the user would know it: "octocat", "ada@example.com". */
  name: string
  /** Its sign-in has run out, so it is signed in to again first. */
  expired?: boolean
}

export type SetUpConnectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the service is called. */
  name: string
  logoUrl?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** What the dialog does, beside the service's logo: "Connect {service}" unless it does something else. */
  title?: string
  /** What its button says, and while it works: "Create", "Creating…". It connects unless told otherwise. */
  accept?: { label: string; pending: string }
  /** What it says while the user has no account on the service, when connecting one is not all it does. */
  noAccount?: string
  /** What is being connected: the kind of resource, or its address. */
  resource?: string
  /** Why the agent asked for it, in its own words. */
  reason?: string
  /** Goes back to choosing what to connect, where that was chosen before this. */
  onBack?: () => void
  /** The user's accounts on the service; none given, they are still being read. */
  accounts?: SetUpConnectionAccount[]
  selectedAccountId?: number
  onSelectAccount: (id: number) => void
  /**
   * Connects an account (another, where there are some), in a window of the service's. Resolves
   * to whether that went ahead; the dialog then waits for the account, which comes in `accounts`.
   */
  onConnectAccount: () => Promise<boolean>
  /** Signs in again to the account chosen, whose sign-in has run out, likewise. */
  onReconnect: (id: number) => Promise<boolean>
  /** The account chosen has not given access to this kind of resource: asks it to, likewise. */
  onGrant?: () => Promise<boolean>
  /** The service's own form for which one it is, once there is an account to choose it with. */
  configurator?: ReactNode
  /** What the form has chosen can be connected. */
  ready: boolean
  /** Connects what was chosen and hands it over, resolving once it has. */
  onAccept: () => Promise<boolean>
}

type Step = 'connect' | 'reconnect' | 'grant'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * What an agent asked to be connected to, set up (`ConnectionRequestCard`'s Set up); or, titled and
 * labelled so, something it asked to be created in one of the user's accounts. Which of the user's
 * accounts on the service, connecting one first where there is none; then which one it is, in the
 * service's own form, filled in with as much as the agent knew. Each step that goes on in a window
 * of the service's waits for it, saying so, and can open it again.
 */
export const SetUpConnectionDialog = ({
  open, onOpenChange, name, logoUrl, color, title, accept = { label: 'Connect', pending: 'Connecting…' }, noAccount, resource, reason, onBack,
  accounts, selectedAccountId, onSelectAccount, onConnectAccount, onReconnect, onGrant, configurator, ready, onAccept,
}: SetUpConnectionDialogProps) => {
  const [pending, setPending] = useState<Step | 'accept'>()
  // A window of the service's was opened for this, and is waited for.
  const [waitingFor, setWaitingFor] = useState<Step>()
  const [problem, setProblem] = useState<string>()
  const selected = accounts?.find(({ id }) => id === selectedAccountId)
  // What was waited for has come once the accounts, their sign-ins or what they may reach change.
  const known = `${accounts?.map(({ id, expired }) => `${id}${expired ? '!' : ''}`).join() ?? ''}:${onGrant !== undefined}`
  const [waited, setWaited] = useState(known)
  if (waited !== known) {
    setWaited(known)
    setWaitingFor(undefined)
  }

  const run = async (step: Step | 'accept', action: () => Promise<boolean>) => {
    setProblem(undefined)
    setPending(step)
    try {
      const went = await action()
      if (went && step !== 'accept') setWaitingFor(step)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(undefined)
    }
  }
  // A step's button says it is opening its window, and once open, that it can be opened again.
  const opening = (step: Step, label: string) => (pending === step ? 'Opening…' : waitingFor === step ? 'Open again' : label)

  const none = accounts?.length === 0
  const usable = selected && !selected.expired ? selected : undefined

  return (
    // Not put away while what was chosen is being connected, whose answer shows here.
    <Dialog open={open} onOpenChange={(next) => { if (pending !== 'accept') onOpenChange(next) }}>
      <ServiceDialogHeader name={name} logoUrl={logoUrl} color={color} title={title ?? `Connect ${name}`} pending={pending === 'accept'}>
        {resource && <Dialog.Description className="text-sm text-kumo-subtle">{resource}</Dialog.Description>}
      </ServiceDialogHeader>

      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6">
        {reason && <blockquote className="rounded-(--surface-radius) bg-kumo-tint px-4 py-3 text-base/5 text-kumo-default">{reason}</blockquote>}
        {accounts === undefined && <p role="status" className="appears-late text-kumo-subtle">Reading your accounts…</p>}
        {none && (
          <p className="text-base/5 text-kumo-subtle">
            {noAccount ?? `Connect your ${name} account first. Then choose what the agent can reach through it.`}
          </p>
        )}
        {accounts && accounts.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-sm font-medium text-kumo-subtle">Account</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Account"
                value={String(selectedAccountId ?? '')}
                onValueChange={(id) => onSelectAccount(Number(id))}
                options={accounts.map(({ id, name: accountName, expired }) => ({ id: String(id), label: expired ? `${accountName} (sign-in expired)` : accountName }))}
              />
              {selected?.expired
                ? <Button disabled={pending !== undefined} onClick={() => void run('reconnect', () => onReconnect(selected.id))}>{opening('reconnect', 'Sign in again')}</Button>
                : <Button variant="ghost" className="text-kumo-subtle" disabled={pending !== undefined} onClick={() => void run('connect', onConnectAccount)}>{opening('connect', 'Use another account')}</Button>}
            </div>
          </section>
        )}
        {usable && onGrant && (
          <Banner
            title={`This account hasn’t given access to ${resource ?? 'this'} yet.`}
            action={{ label: opening('grant', 'Give access'), disabled: pending !== undefined, onSelect: () => void run('grant', onGrant) }}
          />
        )}
        {usable && !onGrant && configurator}
        {waitingFor && <p role="status" className="appears text-base/5 text-kumo-default">Finish in the {name} window. If you closed it, open it again.</p>}
      </div>

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex items-center justify-end gap-2">
          {onBack && <Button variant="ghost" className="me-auto" disabled={pending === 'accept'} onClick={onBack}>Back</Button>}
          <Dialog.Close render={(props) => <Button {...props} disabled={pending === 'accept'}>Cancel</Button>} />
          {none ? (
            <Button variant="primary" disabled={pending !== undefined} onClick={() => void run('connect', onConnectAccount)} className="min-w-0 shrink">
              <span className="truncate">{opening('connect', `Continue to ${name}`)}</span>
            </Button>
          ) : (
            <Button variant="primary" disabled={!ready || pending !== undefined || !usable} onClick={() => void run('accept', onAccept)}>
              {pending === 'accept' ? accept.pending : accept.label}
            </Button>
          )}
        </div>
      </footer>
    </Dialog>
  )
}
