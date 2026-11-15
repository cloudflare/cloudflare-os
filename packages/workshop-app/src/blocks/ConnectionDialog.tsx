import { useState } from 'react'
import { ShieldCheckIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ServiceLogo } from '@/components/ServiceLogo'
import { patternsToConnect } from './resourceGrants'
import { ResourceReachList } from './ResourceReachList'

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

export type ConnectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  service: ConnectionDialogService
  resources: ConnectionDialogResource[]
  /** It comes with the deployment, and is added with no sign-in. */
  ambient?: boolean
  /**
   * Connects it, asking for the resource types switched on (none given: all of them). Resolves
   * to whether it went ahead; once it has, the dialog waits for the window it opened, until its
   * owner closes it.
   */
  onConnect: (urlPatterns: string[] | undefined) => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A service, to connect it: what it is and does, and the kinds of things on it that gadgets can be
 * connected to, with a switch for each the user chooses. Connecting goes on in a window of the
 * service's (`openConnectWindow`); the dialog says so until it is done, and can open it again. An
 * account once connected is managed on a page of its own (`ConnectionAccountView`).
 */
export const ConnectionDialog = ({ open, onOpenChange, service, resources, ambient, onConnect }: ConnectionDialogProps) => {
  const grantable = resources.filter((resource) => resource.grantable).map(({ urlPattern }) => urlPattern)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(grantable))
  const [pending, setPending] = useState(false)
  // A window was opened, and is waited for.
  const [waiting, setWaiting] = useState(false)
  const [problem, setProblem] = useState<string>()

  const noneChosen = grantable.length > 0 && chosen.size === 0
  const toggle = (urlPattern: string, on: boolean) => {
    setWaiting(false)
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(urlPattern)
      else next.delete(urlPattern)
      return next
    })
  }

  const connect = async () => {
    setProblem(undefined)
    setPending(true)
    try {
      if (await onConnect(patternsToConnect(grantable, chosen))) setWaiting(!ambient)
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setPending(false)
    }
  }

  const continueLabel = pending ? 'Opening…' : waiting ? 'Open again' : `Continue to ${service.name}`

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      focusSelf
      title={(
        <span className="flex items-center gap-3">
          <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} size="lg" />
          {`${ambient ? 'Add' : 'Connect'} ${service.name}`}
        </span>
      )}
      description={service.tagline}
      footer={(
        <>
          {noneChosen && <p className="me-auto self-center text-sm text-kumo-subtle">Choose at least one to continue.</p>}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || noneChosen} onClick={() => void connect()}>
            {ambient ? (pending ? 'Adding…' : `Add ${service.name}`) : continueLabel}
          </Button>
        </>
      )}
    >
      {service.description && <p className="text-base/5 text-kumo-default">{service.description}</p>}
      {resources.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="px-1 text-sm font-medium text-kumo-subtle">{grantable.length === 0 ? 'What it can do' : 'Choose what it can reach'}</h3>
          <ResourceReachList
            resources={resources}
            logoUrl={service.logoUrl}
            isOn={(urlPattern) => chosen.has(urlPattern)}
            onToggle={toggle}
            verb="Allow"
            disabled={pending}
          />
        </section>
      )}
      {!ambient && (
        <p className="flex items-start gap-2 text-sm/5 text-kumo-subtle">
          <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Each gadget reaches only what you connect it to, and anyone you share it with is checked first.
        </p>
      )}
      {waiting && (
        <p role="status" className="appears text-base/5 text-kumo-default">
          Finish in the {service.name} window. If you closed it, open it again.
        </p>
      )}
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
    </Dialog>
  )
}
