import { useState, type ReactNode } from 'react'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ServiceLogo } from '@/components/ServiceLogo'
import type { ConnectionDialogResource, ConnectionDialogService } from './ConnectionDialog'
import { isGranted, patternsToGrant } from './resourceGrants'
import { ResourceReachList } from './ResourceReachList'
import { SettingsGroup, SettingsRow } from './SettingsGroup'

export type ConnectionAccountViewProps = {
  service: ConnectionDialogService
  /** Which account it is, when that is not only the service's name. */
  account?: string
  /** Its sign-in has expired. */
  expired?: boolean
  resources: ConnectionDialogResource[]
  /** Those granted, by `urlPattern`; none given, all of them. */
  granted?: string[]
  /** Asks for more resource types, in a window of the service's; resolves to whether it went ahead. */
  onGrant: (urlPatterns: string[]) => Promise<boolean>
  onReconnect?: () => Promise<boolean>
  /** Disconnects it, once asked; as `ConfirmDialog`'s `onConfirm`, `false` if it was not tried. */
  onDisconnect: () => Promise<boolean>
  /**
   * The kinds of change, by label, that the user once let go ahead without asking through the
   * service in every workspace they own, from before that was chosen in each workspace, with the
   * way to make them ask first again and why that last failed.
   */
  everywhere?: { kinds: string[]; onAskFirst: () => Promise<boolean>; problem?: string }
}

const REACH_SHOWN = 5

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const Section = ({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="px-4 text-sm font-medium text-kumo-subtle">{title}</h2>
    {intro && <p className="max-w-xl px-4 pb-1 text-base/6 text-kumo-default">{intro}</p>}
    {children}
  </section>
)

// What still goes ahead in every workspace from before each workspace chose, until made to ask first.
const EverywhereNotice = ({ service, kinds, onAskFirst, problem }: NonNullable<ConnectionAccountViewProps['everywhere']> & { service: string }) => {
  const [pending, setPending] = useState(false)
  return (
    <div className="appears flex flex-col gap-3 rounded-3xl bg-kumo-tint px-4 py-3 sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1 text-base/5 text-pretty text-kumo-default">
        {LIST.format(kinds)} still {kinds.length === 1 ? 'goes' : 'go'} ahead without asking through {service} in every workspace you own, as you chose before it was chosen in each.
      </p>
      <Button
        className="shrink-0 self-start sm:self-auto"
        disabled={pending}
        onClick={() => {
          setPending(true)
          void onAskFirst().finally(() => setPending(false))
        }}
      >
        Ask first everywhere
      </Button>
      {problem && <p role="alert" className="text-sm/5 text-kumo-danger">{problem}</p>}
    </div>
  )
}

/**
 * One connected account, on a page of its own: the service and which account it is, and whether it
 * is still signed in. Then what it can reach, the first few of a long list until asked for all, to
 * which more can be added, as connecting does; where what goes ahead without asking is chosen,
 * which is each workspace, not the account, with whatever still goes ahead everywhere from before
 * that and the way to make it ask first; and last, disconnecting it, asked first.
 */
export const ConnectionAccountView = (props: ConnectionAccountViewProps) => {
  const { service, account, expired, resources, granted, onGrant, onReconnect, onDisconnect, everywhere } = props
  const grantable = resources.filter((resource) => resource.grantable).map(({ urlPattern }) => urlPattern)
  // Those switched on that were not granted.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState(false)
  // A window was opened for this, and is waited for.
  const [waiting, setWaiting] = useState<'grant' | 'reconnect'>()
  const [problem, setProblem] = useState<string>()
  const [disconnecting, setDisconnecting] = useState(false)
  // A long list starts short, so that it does not push what comes after it out of sight.
  const [all, setAll] = useState(resources.length <= REACH_SHOWN + 1)
  const shown = all ? resources : resources.slice(0, REACH_SHOWN)

  const isOn = (urlPattern: string) => chosen.has(urlPattern) || isGranted(granted, urlPattern)
  const toGrant = patternsToGrant(grantable, new Set(grantable.filter(isOn)), granted)
  const toggle = (urlPattern: string, on: boolean) => {
    if (waiting === 'grant') setWaiting(undefined)
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(urlPattern)
      else next.delete(urlPattern)
      return next
    })
  }
  const run = async (action: () => Promise<boolean>, waits: 'grant' | 'reconnect') => {
    setProblem(undefined)
    setPending(true)
    try {
      if (await action()) setWaiting(waits)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }
  const opening = (what: 'grant' | 'reconnect', label: string) => (pending ? 'Opening…' : waiting === what ? 'Open again' : label)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
      <div className="flex flex-col items-center gap-2 pt-8 text-center">
        <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} size="lg" />
        <h1 className="text-xl font-medium text-kumo-default">{service.name}</h1>
        <p className="flex items-center gap-1.5 text-base/5 text-kumo-subtle">
          <span aria-hidden="true" className={expired ? 'size-1.5 shrink-0 rounded-full bg-kumo-danger' : 'size-1.5 shrink-0 rounded-full bg-kumo-success'} />
          {expired ? <span className="text-kumo-danger">Sign-in expired</span> : account ? `Connected as ${account}` : 'Connected'}
        </p>
        {expired && onReconnect && (
          <div className="appears flex flex-col items-center gap-2 pt-2">
            <p className="max-w-sm text-sm/5 text-kumo-subtle">Gadgets and chats can’t reach {service.name} until you sign in again.</p>
            <Button variant="primary" disabled={pending} onClick={() => void run(onReconnect, 'reconnect')}>{opening('reconnect', 'Reconnect')}</Button>
          </div>
        )}
        {waiting && (waiting === 'reconnect' ? expired : toGrant.length > 0) && (
          <p role="status" className="appears text-base/5 text-kumo-default">Finish in the {service.name} window. If you closed it, open it again.</p>
        )}
        {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
      </div>

      {resources.length > 0 && (
        <Section title={grantable.length === 0 ? 'What it can do' : 'What it can reach'}>
          <ResourceReachList
            resources={shown}
            logoUrl={service.logoUrl}
            isOn={isOn}
            // Granted to the account, which only the service can take back.
            isLocked={(urlPattern) => isGranted(granted, urlPattern)}
            onToggle={toggle}
            verb="Grant"
            disabled={pending}
          />
          {shown.length < resources.length && (
            <Button variant="ghost" className="self-start" onClick={() => setAll(true)}>Show all {resources.length}</Button>
          )}
          {toGrant.length > 0 && (
            <div className="appears flex flex-wrap items-center justify-end gap-2 px-1">
              <p className="me-auto text-sm text-kumo-subtle">{toGrant.length} to add, in {service.name}</p>
              <Button disabled={pending} onClick={() => { setChosen(new Set()); setWaiting(undefined) }}>Cancel</Button>
              <Button variant="primary" disabled={pending} onClick={() => void run(() => onGrant(toGrant), 'grant')}>{opening('grant', `Continue to ${service.name}`)}</Button>
            </div>
          )}
        </Section>
      )}

      <Section title="When it changes something">
        <p className="max-w-xl px-4 text-base/6 text-pretty text-kumo-default">
          Reading never asks. A change through {service.name} asks first, unless the workspace it’s made in makes that kind of change automatic, on its Connections tab.
        </p>
        {everywhere && everywhere.kinds.length > 0 && <EverywhereNotice service={service.name} {...everywhere} />}
      </Section>

      <SettingsGroup label="Disconnect">
        <SettingsRow
          title={`Disconnect ${service.name}`}
          description="Gadgets and chats connected through this account lose access. You can connect it again later."
          danger
          control={<Button variant="danger" onClick={() => setDisconnecting(true)}>Disconnect</Button>}
        />
      </SettingsGroup>
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        destructive
        title={`Disconnect ${service.name}?`}
        description="Gadgets and chats connected through this account lose access. You can connect it again later."
        confirm="Disconnect"
        onConfirm={onDisconnect}
      />
    </div>
  )
}
