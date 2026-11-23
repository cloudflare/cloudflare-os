import { useMemo, useState, type ReactNode } from 'react'
import { ArrowRight01Icon, Cancel01Icon } from '@/components/icons'
import { Button, Dialog, TextField } from '@gadgets/ui'
import { ServiceLogo } from '@/components/ServiceLogo'

/** A kind of resource one of the services offers: a GitHub repository, a Google spreadsheet. */
export type ConnectionChoice = {
  key: string
  service: { name: string; logoUrl?: string; color?: string; glyph?: ReactNode }
  /** The kind, as the service names it: "Repository". */
  title: string
  /** What it is, as the service says, under the title. */
  description?: string
  /** The user has an account on the service already. */
  connected: boolean
}

export type AddConnectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it is added to, for the line under the title: "this chat". */
  to: string
  /** What can be connected; none given, it is still being read. */
  choices?: readonly ConnectionChoice[]
  /** Why there is nothing to choose from, when it could not be read. */
  problem?: string
  onChoose: (choice: ConnectionChoice) => void
}

const GROUPS = [
  { connected: true, label: 'Your services' },
  { connected: false, label: 'More services' },
] as const

// What the dialog holds, which is only there while it is open: what is typed starts over each time.
const AddConnectionContent = ({ to, choices, problem, onChoose }: Omit<AddConnectionDialogProps, 'open' | 'onOpenChange'>) => {
  const [query, setQuery] = useState('')
  const found = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return choices?.filter(({ service, title }) => words.every((word) => `${service.name} ${title}`.toLowerCase().includes(word)))
  }, [choices, query])

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
          <Dialog.Title className="text-lg font-medium text-kumo-default">Add a connection</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">Choose what {to} can use. You pick which one next, in the service’s own form.</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>
      <div className="px-6 pb-3">
        <TextField aria-label="Find a service" type="search" placeholder="Find a service" value={query} onValueChange={setQuery} autoFocus />
      </div>
      <div className="flex min-h-0 grow flex-col gap-4 overflow-y-auto px-4 pb-4">
        {problem && <p role="alert" className="px-2 text-base/5 text-kumo-danger">{problem}</p>}
        {!problem && found === undefined && <p role="status" className="appears-late px-2 text-base text-kumo-subtle">Reading your services…</p>}
        {found?.length === 0 && (
          <p className="px-2 text-base text-kumo-subtle">{query.trim() ? `Nothing called “${query.trim()}” can be connected.` : 'Nothing can be connected here yet.'}</p>
        )}
        {GROUPS.map(({ connected, label }) => {
          const rows = found?.filter((choice) => choice.connected === connected) ?? []
          if (rows.length === 0) return null
          return (
            <section key={label} aria-label={label} className="flex flex-col">
              <h3 className="px-3 pb-1 text-sm font-medium text-kumo-subtle">{label}</h3>
              {rows.map((choice) => (
                // As a service is a row on the Connections page: all of it a button, with where it goes at its end.
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => onChoose(choice)}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5"
                >
                  <ServiceLogo name={choice.service.name} src={choice.service.logoUrl} glyph={choice.service.glyph} color={choice.service.color} small />
                  <span className="flex min-w-0 flex-1 flex-col leading-snug">
                    <span className="truncate font-medium text-kumo-default">{choice.title}</span>
                    <span className="truncate text-kumo-subtle">{choice.description ? `${choice.service.name} · ${choice.description}` : choice.service.name}</span>
                  </span>
                  <ArrowRight01Icon aria-hidden="true" weight="bold" className="size-3.5 shrink-0 text-kumo-subtle transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </button>
              ))}
            </section>
          )
        })}
      </div>
    </>
  )
}

/**
 * The first step of adding a connection to a chat: what to connect, as each kind of resource the
 * services offer (a repository, a spreadsheet), those the user has an account on first, found by
 * service or kind as typed. Choosing one goes on to the service's own form for which
 * (`SetUpConnectionDialog`).
 */
export const AddConnectionDialog = ({ open, onOpenChange, ...props }: AddConnectionDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <AddConnectionContent {...props} />
  </Dialog>
)
