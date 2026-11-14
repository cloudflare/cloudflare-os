import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { ShieldCheckIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ServiceLogo } from '@/components/ServiceLogo'
import { isGranted, patternsToConnect, patternsToGrant } from './resourceGrants'

export type ConnectionDialogService = {
  name: string
  /** What it does, in a line: "Repositories, issues and pull requests". */
  tagline?: string
  /** What connecting it lets gadgets do, in a few sentences. */
  description?: string
  logoUrl?: string
  color?: string
}

/** One kind of thing on the service a gadget can be connected to: "Repository", "Calendar". */
export type ConnectionDialogResource = {
  urlPattern: string
  title: string
  description: string
  iconUrl?: string
  /** It is granted on its own, so it has a switch. */
  grantable?: boolean
}

type Common = {
  open: boolean
  onOpenChange: (open: boolean) => void
  service: ConnectionDialogService
  resources: ConnectionDialogResource[]
}

export type ConnectionDialogProps = Common & (
  | {
    mode: 'connect'
    /** It comes with the deployment, and is added with no sign-in. */
    ambient?: boolean
    /**
     * Connects it, asking for the resource types switched on (none given: all of them). Resolves
     * to whether it went ahead; once it has, the dialog waits for the window it opened, until its
     * owner closes it.
     */
    onConnect: (urlPatterns: string[] | undefined) => Promise<boolean>
  }
  | {
    mode: 'manage'
    /** Which account it is, when that is not only the service's name. */
    account?: string
    /** Its sign-in has expired. */
    expired?: boolean
    /** Those granted, by `urlPattern`; none given, all of them. */
    granted?: string[]
    /** Asks for more resource types, as connecting does; it waits likewise until they are granted. */
    onGrant: (urlPatterns: string[]) => Promise<boolean>
    onReconnect?: () => Promise<boolean>
    /** Disconnects it, once asked; as `ConfirmDialog`'s `onConfirm`, `false` if it was not tried. */
    onDisconnect: () => Promise<boolean>
  }
)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A service, to connect it or to manage the account it is connected with: what it is and does,
 * and the kinds of things on it that gadgets can be connected to, with a switch for each the user
 * chooses. Connecting goes on in a window of the service's (`openConnectWindow`); the dialog says
 * so until it is done, and can open it again. Once connected, a resource type can be added but
 * not taken away, as the service grants it to the account. Disconnecting asks first.
 */
export const ConnectionDialog = (props: ConnectionDialogProps) => {
  const { open, onOpenChange, service, resources } = props
  const manage = props.mode === 'manage'
  const granted = manage ? props.granted : undefined
  const grantable = resources.filter((resource) => resource.grantable).map(({ urlPattern }) => urlPattern)
  // Connecting: those switched on. Managing: those switched on that were not granted.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(manage ? [] : grantable))
  const [pending, setPending] = useState(false)
  // A window was opened, and is waited for.
  const [waiting, setWaiting] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [disconnecting, setDisconnecting] = useState(false)

  const isOn = (urlPattern: string) => chosen.has(urlPattern) || (manage && isGranted(granted, urlPattern))
  const toGrant = manage ? patternsToGrant(grantable, new Set(grantable.filter(isOn)), granted) : []
  const noneChosen = !manage && grantable.length > 0 && chosen.size === 0
  const toggle = (urlPattern: string, on: boolean) => {
    setWaiting(false)
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(urlPattern)
      else next.delete(urlPattern)
      return next
    })
  }

  const run = async (action: () => Promise<boolean>, waits: boolean) => {
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

  const ambient = props.mode === 'connect' && props.ambient
  const title = manage ? service.name : `${ambient ? 'Add' : 'Connect'} ${service.name}`
  // Waiting for the window, which can be opened again. Done with once what it was for has come.
  const stillWaiting = waiting && (!manage || toGrant.length > 0)
  const continueLabel = pending ? 'Opening…' : stillWaiting ? 'Open again' : `Continue to ${service.name}`

  const footer = props.mode === 'connect' ? (
    <>
      {noneChosen && <p className="me-auto self-center text-sm text-kumo-subtle">Choose at least one to continue.</p>}
      <Button onClick={() => onOpenChange(false)}>Cancel</Button>
      <Button
        variant="primary"
        disabled={pending || noneChosen}
        onClick={() => void run(() => props.onConnect(patternsToConnect(grantable, chosen)), !ambient)}
      >
        {ambient ? (pending ? 'Adding…' : `Add ${service.name}`) : continueLabel}
      </Button>
    </>
  ) : toGrant.length > 0 ? (
    <>
      <p className="me-auto self-center text-sm text-kumo-subtle">{toGrant.length} to add</p>
      <Button disabled={pending} onClick={() => { setChosen(new Set()); setWaiting(false) }}>Cancel</Button>
      <Button variant="primary" disabled={pending} onClick={() => void run(() => props.onGrant(toGrant), true)}>{continueLabel}</Button>
    </>
  ) : (
    <>
      <Button variant="danger" className="me-auto" onClick={() => setDisconnecting(true)}>Disconnect</Button>
      {props.expired && props.onReconnect ? (
        <Button variant="primary" disabled={pending} onClick={() => void run(props.onReconnect!, true)}>
          {pending ? 'Opening…' : waiting ? 'Open again' : 'Reconnect'}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
      )}
    </>
  )

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="xl"
        focusSelf
        title={(
          <span className="flex items-center gap-3">
            <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} size="lg" />
            {title}
          </span>
        )}
        description={manage ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={props.expired ? 'size-1.5 shrink-0 rounded-full bg-kumo-danger' : 'size-1.5 shrink-0 rounded-full bg-kumo-success'} />
            {props.expired ? 'Sign-in expired. Reconnect to keep using it.' : props.account ?? 'Connected'}
          </span>
        ) : service.tagline}
        footer={footer}
      >
        {service.description && <p className="text-base/5 text-kumo-default">{service.description}</p>}
        {resources.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="px-1 text-sm font-medium text-kumo-subtle">
              {grantable.length === 0 ? 'What it can do' : manage ? 'What it can reach' : 'Choose what it can reach'}
            </h3>
            <ul className="flex flex-col rounded-2xl bg-kumo-tint p-1.5">
              {resources.map((resource) => {
                const has = manage && isGranted(granted, resource.urlPattern)
                return (
                  <li key={resource.urlPattern} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
                    <ServiceLogo name={resource.title} src={resource.iconUrl ?? service.logoUrl} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-medium text-kumo-default">{resource.title}</span>
                      <span title={resource.description} className="line-clamp-2 text-sm/5 text-kumo-subtle">{resource.description}</span>
                    </div>
                    {resource.grantable && (
                      <Switch
                        size="sm"
                        aria-label={`${manage ? 'Grant' : 'Allow'} ${resource.title}`}
                        checked={isOn(resource.urlPattern)}
                        // Granted to the account, which only the service can take back.
                        disabled={has || pending}
                        onCheckedChange={(on) => toggle(resource.urlPattern, on)}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {!ambient && (
          <p className="flex items-start gap-2 text-sm/5 text-kumo-subtle">
            <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            Each gadget reaches only what you connect it to, and anyone you share it with is checked first.
          </p>
        )}
        {stillWaiting && (
          <p role="status" className="appears text-base/5 text-kumo-default">
            Finish in the {service.name} window. If you closed it, open it again.
          </p>
        )}
        {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
      </Dialog>
      {manage && (
        <ConfirmDialog
          open={disconnecting}
          onOpenChange={setDisconnecting}
          destructive
          title={`Disconnect ${service.name}?`}
          description="Gadgets connected to it through this account lose access. You can connect it again later."
          confirm="Disconnect"
          onConfirm={props.onDisconnect}
        />
      )}
    </>
  )
}
