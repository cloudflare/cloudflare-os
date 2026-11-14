import { useMemo, useState } from 'react'
import { Input } from '@cloudflare/kumo'
import { CaretRightIcon } from '@phosphor-icons/react'
import { Dialog } from '@/components/Dialog'
import { ServiceLogo } from '@/components/ServiceLogo'

/** A kind of resource one of the user's services offers: a GitHub repository, a Google spreadsheet. */
export type ConnectionChoice = {
  key: string
  service: { name: string; logoUrl?: string; color?: string }
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
  /** What it is added to, for the line under the title: "this chat", "Tip Jar". */
  to: string
  /** What can be connected; none given, it is still loading. */
  choices?: readonly ConnectionChoice[]
  /** Why there is nothing to choose from, when it could not be read. */
  problem?: string
  onChoose: (choice: ConnectionChoice) => void
}

const GROUPS = [
  { connected: true, label: 'Your services' },
  { connected: false, label: 'More services' },
] as const

/**
 * The first step of adding a connection to a chat or a gadget: what to connect, as each kind of
 * resource the user's services offer (a repository, a spreadsheet), those of services they have
 * connected first, found by service or kind as typed. Choosing one goes on to the service's own
 * form for which (`SetUpConnectionDialog`).
 */
export const AddConnectionDialog = ({ open, onOpenChange, to, choices, problem, onChoose }: AddConnectionDialogProps) => {
  const [query, setQuery] = useState('')
  const found = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return choices?.filter(({ service, title }) => words.every((word) => `${service.name} ${title}`.toLowerCase().includes(word)))
  }, [choices, query])

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add a connection"
      description={`Choose what ${to} can use. You pick which one next, in the service’s own window.`}
    >
      <Input aria-label="Find a service" type="search" placeholder="Find a service" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      {problem && <p role="alert" className="text-base/5 text-kumo-danger">{problem}</p>}
      {!problem && found === undefined && <p role="status" className="appears-late text-base text-kumo-subtle">Loading your services…</p>}
      {found?.length === 0 && <p className="text-base text-kumo-subtle">{query.trim() ? `Nothing called “${query.trim()}” can be connected.` : 'Nothing can be connected here yet.'}</p>}
      {found && found.length > 0 && (
        <div className="-mx-1 flex max-h-[min(60vh,28rem)] flex-col gap-4 overflow-y-auto px-1">
          {GROUPS.map(({ connected, label }) => {
            const rows = found.filter((choice) => choice.connected === connected)
            if (rows.length === 0) return null
            return (
              <section key={label} aria-label={label} className="flex flex-col gap-1.5">
                <h3 className="px-1 text-sm font-medium text-kumo-subtle">{label}</h3>
                <div className="flex flex-col rounded-2xl bg-kumo-tint p-1.5">
                  {rows.map((choice) => (
                    <button
                      key={choice.key}
                      type="button"
                      onClick={() => onChoose(choice)}
                      className="group flex items-center gap-3 rounded-xl py-2 pr-2 pl-2.5 text-left text-base outline-none hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5 focus-visible:ring-2 focus-visible:ring-kumo-ring"
                    >
                      <ServiceLogo name={choice.service.name} src={choice.service.logoUrl} color={choice.service.color} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-kumo-default">{choice.title}</span>
                        <span className="truncate text-sm text-kumo-subtle">{choice.description ? `${choice.service.name} · ${choice.description}` : choice.service.name}</span>
                      </span>
                      <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </Dialog>
  )
}
