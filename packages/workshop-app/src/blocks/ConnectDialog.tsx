import { useState } from 'react'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ServiceDialogBody } from './ServiceDialogBody'
import { ServiceDialogHeader } from './ServiceDialogHeader'
import { usePending, type ActionResult } from './usePending'

/** A kind of thing a service gives access to, such as its mail or its calendar. */
export type ConnectDialogResource = {
  id: string
  title: string
  description?: string
  /** Given on its own, so that it can be left out when the service is connected. */
  choice?: boolean
}

type ServiceProps = {
  /** What the service is called. */
  name: string
  logoUrl?: string
  /** The service's own colour, for behind its logo. */
  color?: string
  /** What it is for, in a few words. */
  tagline?: string
  /** What it is for, in a few sentences. */
  description?: string
  /** The kinds of thing it gives access to. */
  resources?: ConnectDialogResource[]
  /** Added at once, with nothing to sign in to. */
  instant?: boolean
  /** Why the last try did not connect it. */
  problem?: string
}

export type ConnectDialogProps = ServiceProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Given the kinds of access chosen, or nothing when it is all the service has. Whoever shows the
   * dialog puts it away once the service is on its way to being connected.
   */
  onConnect: (access?: string[]) => ActionResult
}

// What the dialog holds, which is only there while it is open: what is chosen starts over each time.
const ConnectDialogContent = ({ name, logoUrl, color, tagline, description, resources = [], instant = false, problem, pending, onConnect }: ServiceProps & {
  pending: boolean
  onConnect: (access?: string[]) => void
}) => {
  const choices = resources.filter(({ choice }) => choice)
  // Those turned off, so that all are on to start with, whichever there are.
  const [off, setOff] = useState<string[]>([])
  const chosen = choices.filter(({ id }) => !off.includes(id)).map(({ id }) => id)
  const noneChosen = choices.length > 0 && chosen.length === 0

  return (
    <>
      <ServiceDialogHeader name={name} logoUrl={logoUrl} color={color} title={`${instant ? 'Add' : 'Connect'} ${name}`} pending={pending}>
        {tagline && <Dialog.Description className="text-sm text-kumo-subtle">{tagline}</Dialog.Description>}
      </ServiceDialogHeader>

      <ServiceDialogBody
        description={description}
        label={choices.length > 0 ? 'Give access to' : 'Gives access to'}
        access={resources.map(({ id, title, description: detail, choice }) => ({
          id,
          title,
          description: detail,
          toggle: choice
            ? {
                label: `Give access to ${title}`,
                checked: !off.includes(id),
                onChange: (on) => setOff(on ? off.filter((other) => other !== id) : [...off, id]),
              }
            : undefined,
        }))}
      />

      <footer className="flex flex-col gap-3 p-6">
        {problem && <Banner title={problem} />}
        <div className="flex items-center gap-2">
          {/* Beside the buttons, where it has room already, so that it moves nothing as it comes and goes. */}
          <p className="min-w-0 flex-1 px-1.5 text-sm text-kumo-subtle">{noneChosen && 'Choose at least one to continue.'}</p>
          <Dialog.Close render={(props) => <Button {...props} disabled={pending}>Cancel</Button>} />
          {/* It says the service's name, which may be longer than there is room for: it is cut short rather than let out of the dialog. */}
          <Button
            variant="primary"
            disabled={pending || noneChosen}
            onClick={() => onConnect(chosen.length === choices.length ? undefined : chosen)}
            className="min-w-0 shrink"
          >
            <span className="truncate">{instant ? (pending ? 'Adding…' : `Add ${name}`) : pending ? 'Opening…' : `Continue to ${name}`}</span>
          </Button>
        </div>
      </footer>
    </>
  )
}

/**
 * What there is to know of a service before it is connected, over the page: what it is for, what
 * it gives access to, with a switch for each kind that is given on its own, all on to start with,
 * and the way on to the service to sign in, or to add it where there is nothing to sign in to.
 */
export const ConnectDialog = ({ open, onOpenChange, onConnect, ...service }: ConnectDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while the service is being connected, whose answer shows here.
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      <ConnectDialogContent
        {...service}
        pending={pending}
        onConnect={(access) => {
          if (!pending) run(() => onConnect(access))
        }}
      />
    </Dialog>
  )
}
