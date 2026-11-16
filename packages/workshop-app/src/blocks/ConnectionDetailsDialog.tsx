import { useState, type ReactNode } from 'react'
import { ArrowSquareOutIcon, CaretRightIcon } from '@phosphor-icons/react'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { LinkButton } from '@/components/LinkButton'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ChangeRulesList, type ChangeRule } from './ChangeRulesList'

/** Something that uses a connection: a gadget bound to it, or a chat that reached something through it. */
export type ConnectionUse = {
  key: string
  icon: ReactNode
  title: string
  /** What else to know of it: "Made by Ada, so it asks separately". */
  detail?: string
  href?: string
  onOpen: () => void
}

export type ConnectionDetailsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called once it has gone. */
  onClosed?: () => void
  title: string
  /** Its kind's icon, or else its service's logo. */
  logo: { name: string; src?: string; color?: string }
  /** What it is, in words: "Google Doc", or for one every chat has, its service. */
  kind?: string
  /** Where it is in its service, to open it there. */
  serviceLink?: { label: string; href: string }
  /** What uses it, gadgets first; undefined while that is read. */
  uses?: ConnectionUse[]
  changes: ChangeRule[]
  onChange: (kind: ActionKind, automatic: boolean) => void
  /** Why nothing can be made automatic, in place of the choices: everything asks here, or the viewer may not choose. */
  locked?: string
  /** Why the last change to what goes ahead did not hold. */
  problem?: string
  /** Goes to the account it goes through. */
  account?: { label: string; href?: string; onOpen: () => void }
  /** Goes to every connection of the workspace, from a page that shows some of them. */
  onSeeAll?: () => void
}

const USES_SHOWN = 5

const UseRow = ({ use }: { use: ConnectionUse }) => (
  <LinkButton
    href={use.href}
    onClick={use.onOpen}
    className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left text-base outline-none hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5 focus-visible:ring-2 focus-visible:ring-kumo-ring"
  >
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center">{use.icon}</span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-kumo-default">{use.title}</span>
      {use.detail && <span className="truncate text-sm text-kumo-subtle">{use.detail}</span>}
    </span>
    <CaretRightIcon aria-hidden="true" className="size-4 shrink-0 text-kumo-subtle" />
  </LinkButton>
)

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section aria-label={title} className="flex flex-col gap-2">
    <h3 className="px-1 text-sm font-medium text-kumo-subtle">{title}</h3>
    {children}
  </section>
)

/**
 * One of a workspace's connections: what it is, and where in its service; every kind of change it
 * can make, each "Ask first" or "Allow" for the whole workspace (`ChangeRulesList`), which is
 * where that is chosen, first, as it is what the dialog is opened for; then what uses it, gadgets,
 * agents, then chats, each opening where it is, the first few until asked for all. Reading never asks, and it says so. Its footer goes to the account it
 * goes through and, from a chat's or a gadget's page, to the workspace's other connections.
 */
export const ConnectionDetailsDialog = ({
  open, onOpenChange, onClosed, title, logo, kind, serviceLink, uses, changes, onChange, locked, problem, account, onSeeAll,
}: ConnectionDetailsDialogProps) => {
  const [all, setAll] = useState(false)
  const shown = uses && (all ? uses : uses.slice(0, USES_SHOWN))
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => {
        setAll(false)
        onClosed?.()
      }}
      size="xl"
      title={(
        <span className="flex items-center gap-3">
          <ServiceLogo name={logo.name} src={logo.src} color={logo.color} size="lg" />
          <span className="min-w-0 break-words">{title}</span>
        </span>
      )}
      description={(kind || serviceLink) && (
        <span className="flex flex-wrap items-baseline gap-x-2">
          {kind}
          {serviceLink && (
            <a
              href={serviceLink.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm font-medium text-kumo-default underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              {serviceLink.label}
              <ArrowSquareOutIcon aria-hidden="true" className="size-3.5 text-kumo-subtle" />
            </a>
          )}
        </span>
      )}
      footer={(
        <>
          {account && (
            <Button variant="ghost" className="me-auto" onClick={account.onOpen}>{account.label}</Button>
          )}
          {onSeeAll && <Button onClick={onSeeAll}>All connections</Button>}
          <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
        </>
      )}
    >
      <Section title="When it changes something">
        <p className="px-1 text-base/5 text-pretty text-kumo-default">
          Reading is always allowed. Changes you allow here go ahead without asking, in any chat or gadget in this workspace.
        </p>
        {changes.length === 0
          ? <p className="px-1 text-base text-kumo-subtle">It can only read.</p>
          : <ChangeRulesList changes={changes} onChange={onChange} disabled={locked !== undefined} />}
        {locked && <p className="px-1 text-sm/5 text-kumo-subtle">{locked}</p>}
        {problem && <p role="alert" className="px-1 text-sm/5 text-kumo-danger">{problem}</p>}
      </Section>
      <Section title="Used by">
        {shown === undefined ? (
          <p role="status" className="appears-late px-1 text-base text-kumo-subtle">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="appears px-1 text-base text-pretty text-kumo-subtle">Nothing uses it yet. Any chat or gadget in this workspace can.</p>
        ) : (
          <div className="appears -mx-1 flex flex-col">
            {shown.map((use) => <UseRow key={use.key} use={use} />)}
            {uses && shown.length < uses.length && (
              <Button variant="ghost" className="ms-1 self-start" onClick={() => setAll(true)}>Show all {uses.length}</Button>
            )}
          </div>
        )}
      </Section>
    </Dialog>
  )
}
