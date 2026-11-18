import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { SignOutIcon, UserPlusIcon } from '@phosphor-icons/react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { ServiceDialogBody } from './ServiceDialogBody'
import { ServiceDialogHeader } from './ServiceDialogHeader'
import { usePending, type ActionResult } from './usePending'

/** A kind of thing a service gives access to, such as its mail or its calendar, and whether the account has it. */
export type ManageConnectionResource = {
  id: string
  title: string
  description?: string
  /** Given on its own, so that an account may not have it. */
  choice?: boolean
  /** Whether the account was given it. */
  granted?: boolean
}

type AccountProps = {
  /** What the service is called. */
  name: string
  logoUrl?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** What it is for, in a few words. */
  tagline?: string
  /** What it is for, in a few sentences. */
  description?: string
  /** `expired` has to be signed in to again before it can be used. */
  status: 'connected' | 'expired'
  /** Whose account it is, as the service knows them. */
  account?: string
  /** The kinds of thing the service gives access to. */
  resources?: ManageConnectionResource[]
  /** Why the last thing asked for was not done. */
  problem?: string
}

type AccountActions = {
  /** Gives the account kinds of access it does not have. */
  onAddAccess: (access: string[]) => ActionResult
  onReconnect: () => ActionResult
  /** Connects another account of the service, where it takes more than one. */
  onConnectAnother?: () => ActionResult
  onDisconnect: () => ActionResult
}

export type ManageConnectionDialogProps = AccountProps & AccountActions & {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Asked = 'access' | 'reconnect' | 'another' | 'disconnect'

// What the dialog holds, which is only there while it is open: what is chosen starts over each time.
const ManageConnectionDialogContent = ({ name, logoUrl, color, tagline, description, status, account, resources = [], problem, pending, onAsk, onAddAccess, onReconnect, onConnectAnother, onDisconnect }: AccountProps & AccountActions & {
  pending: boolean
  onAsk: (action: () => ActionResult) => void
}) => {
  const expired = status === 'expired'
  // The kinds of access switched on that the account does not have yet.
  const [chosen, setChosen] = useState<string[]>([])
  const adding = resources.filter(({ id, choice, granted }) => choice && !granted && chosen.includes(id)).map(({ id }) => id)
  // Which button says it is waiting.
  const [asked, setAsked] = useState<Asked>()
  const ask = (what: Asked, action: () => ActionResult) => {
    setAsked(what)
    onAsk(action)
  }
  const waiting = (what: Asked) => pending && asked === what
  // Asked for twice, as whatever uses the account loses it, from either of the buttons that do it.
  const disconnect = {
    title: `Disconnect ${name}?`,
    description: `Whatever uses ${name} through ${account ?? 'this account'} will lose access to it.`,
    confirmLabel: 'Disconnect',
    onConfirm: () => ask('disconnect', onDisconnect),
    disabled: pending,
  }

  return (
    <>
      <ServiceDialogHeader name={name} logoUrl={logoUrl} color={color} title={name} pending={pending}>
        {tagline && <Dialog.Description className="text-sm text-kumo-subtle">{tagline}</Dialog.Description>}
      </ServiceDialogHeader>

      <ServiceDialogBody
        description={description}
        account={account === undefined ? undefined : {
          label: account,
          // The same as Disconnect at the foot, beside what it disconnects.
          action: (
            <ConfirmMenu {...disconnect} icon={SignOutIcon} aria-label={`Disconnect ${account}`} triggerVariant="ghost" triggerClassName="text-kumo-danger" side="bottom" />
          ),
        }}
        label="Has access to"
        access={resources.map(({ id, title, description: detail, choice, granted }) => ({
          id,
          title,
          description: detail,
          toggle: choice
            ? {
                label: `Give access to ${title}`,
                checked: granted || chosen.includes(id),
                // What it has stays: access is only taken back by disconnecting. And one that
                // cannot be used is signed in to again before it is given more.
                disabled: granted || expired || pending,
                note: granted
                  ? 'To take this access back, disconnect the account.'
                  : expired ? 'Reconnect the account before giving it more access.' : undefined,
                onChange: (on) => setChosen(on ? [...chosen, id] : chosen.filter((other) => other !== id)),
              }
            : undefined,
        }))}
      >
        {expired && (
          <Banner
            title="Sign-in expired"
            description={`Sign in to ${name} again to keep using this account.`}
            action={{ label: waiting('reconnect') ? 'Opening…' : 'Reconnect', disabled: pending, onSelect: () => ask('reconnect', onReconnect) }}
          />
        )}
      </ServiceDialogBody>

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        {/* Where there is no room for its three buttons, Disconnect goes on a line of its own, above the two that end the dialog. A button that says the service's name is cut short instead, as the name may be longer than any line. */}
        <div className={cn('flex items-center justify-end gap-2', adding.length === 0 && 'flex-wrap')}>
          {adding.length > 0 ? (
            <>
              <p className="min-w-0 flex-1 truncate px-1.5 text-sm text-kumo-subtle">{adding.length} to add</p>
              <Button disabled={pending} onClick={() => setChosen([])}>Cancel</Button>
              <Button variant="primary" disabled={pending} onClick={() => ask('access', () => onAddAccess(adding))} className="min-w-0 shrink">
                <span className="truncate">{waiting('access') ? 'Opening…' : `Continue to ${name}`}</span>
              </Button>
            </>
          ) : (
            <>
              <ConfirmMenu {...disconnect} label={waiting('disconnect') ? 'Disconnecting…' : 'Disconnect'} align="start" />
              <span className="ms-auto flex items-center gap-2">
                {onConnectAnother && (
                  <Button icon={UserPlusIcon} disabled={pending} onClick={() => ask('another', onConnectAnother)}>
                    {waiting('another') ? 'Opening…' : 'Add account'}
                  </Button>
                )}
                <Dialog.Close render={(props) => <Button {...props} variant="primary" disabled={pending}>Done</Button>} />
              </span>
            </>
          )}
        </div>
      </footer>
    </>
  )
}

/**
 * What there is to know of a connected account, over the page: what its service is for, whose
 * account it is, and what it has access to, with a switch for each kind given on
 * its own. One it does not have can be switched on, which goes on to the service to give it. An
 * account whose sign-in ran out says so first, with the way to sign in to it again. From here
 * another account of the service is connected, and the account is disconnected, which is asked
 * for twice. Whoever shows the dialog puts
 * it away once what was asked for is done, or on its way.
 */
export const ManageConnectionDialog = ({ open, onOpenChange, ...account }: ManageConnectionDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while something is asked of the account, whose answer shows here.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      <ManageConnectionDialogContent
        {...account}
        pending={pending}
        onAsk={(action) => {
          if (!pending) run(action)
        }}
      />
    </Dialog>
  )
}
