import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, DropdownMenu, useReducedMotion } from '@gadgets/ui'
import { Cancel01Icon } from '@/components/icons'
import { ServiceLogo } from '@/components/ServiceLogo'

/** What a connection waits on the user for: one thing to do, or one of several to choose. */
export type ComposerConnectionAsk =
  | { label: string; onAct: () => void; choices?: never }
  | { label: string; choices: readonly { id: string; label: string }[]; onChoose: (id: string) => void }

/**
 * A connection added to a draft, which the chat has once the message goes: a pill in the draft
 * once it is made, and until then, while it waits on something, a line over it.
 */
export type ComposerConnection = {
  key: string
  /** Which one it is: "cloudflare/gadgets", "Q3 forecast". */
  title: string
  /** What kind it is, as its service names it: "Repository". */
  kind?: string
  /** What it holds, in a line, as its service says: the start of a document, say. */
  snippet?: string
  service: { name: string; logoUrl?: string; color?: string; glyph?: ReactNode }
  /** Still being made, from a link in the draft: the draft cannot go until it is. */
  pending?: boolean
  /** Why it could not be made: it does not go with the draft, and says so until taken off. */
  problem?: string
  /**
   * It is not made until the user does something, such as connect the service it is on, which is
   * offered at the end of its line. Until then it does not go with the draft, nor hold it: the
   * link it came from goes as it was written.
   */
  ask?: ComposerConnectionAsk
  /** What is said in place of its kind, such as what it waits for: "Connect Google to add it". */
  note?: string
}

/** What kind a connection is, on its service: "GitHub repository", or "Google Doc" as it is named already. */
export const connectionKind = ({ kind, service }: ComposerConnection) => {
  if (!kind) return service.name
  return kind.toLowerCase().startsWith(service.name.toLowerCase()) ? kind : `${service.name} ${kind.toLowerCase()}`
}

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

// The one thing a line offers to do, small enough for its line and plain against it.
const ASK = 'h-6 shrink-0 px-2.5 text-sm'

const Line = ({ connection, onRemove }: { connection: ComposerConnection; onRemove: () => void }) => {
  const { ask } = connection
  return (
    <div className="flex h-9 items-center gap-2 rounded-[15px] bg-kumo-base ps-1.5 pe-1.5 text-sm ring-1 ring-kumo-line ring-inset">
      <ServiceLogo name={connection.service.name} src={connection.service.logoUrl} glyph={connection.service.glyph} color={connection.service.color} tiny />
      <span className="sr-only">Adding the connection:</span>
      <span className="min-w-0 shrink truncate font-medium text-kumo-default">{connection.title}</span>
      {connection.problem
        ? <span role="alert" title={connection.problem} className="min-w-0 flex-1 truncate text-kumo-danger">{connection.problem}</span>
        : connection.pending
        ? <span role="status" className="min-w-0 flex-1 truncate text-kumo-subtle">Connecting…</span>
        : <span className="min-w-0 flex-1 truncate text-kumo-subtle">{connection.note ?? connectionKind(connection)}</span>}
      {ask && (ask.choices
        ? (
            <DropdownMenu label={ask.label} caret keepTrigger triggerClassName={ASK} align="end">
              {ask.choices.map(({ id, label }) => <DropdownMenu.Item key={id} onSelect={() => ask.onChoose(id)}>{label}</DropdownMenu.Item>)}
            </DropdownMenu>
          )
        : <Button onClick={ask.onAct} className={ASK}>{ask.label}</Button>)}
      <Button
        variant="ghost"
        icon={<Cancel01Icon weight="bold" />}
        aria-label={`Don’t add ${connection.title}`}
        title={`Don’t add ${connection.title}`}
        onClick={onRemove}
        className="size-6 text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3"
      />
    </div>
  )
}

/**
 * The links in a draft that wait on something before they are connections, each a line at the
 * top of the composer: the service's logo, which one, and why it is not one yet (still
 * connecting, why it could not be connected, or what it waits on the user for, with that offered
 * at its end), with the way to take it off. One that is made is a pill in the draft instead,
 * which has nothing to press in it.
 */
export const ComposerConnectionLines = ({ connections, onRemove }: {
  connections: readonly ComposerConnection[]
  onRemove: (key: string) => void
}) => {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION
  return (
    <AnimatePresence initial={false}>
      {connections.map((connection) => (
        <motion.div
          key={connection.key}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={transition}
          className="overflow-hidden"
        >
          <div className="px-1.5 pt-1.5">
            <Line connection={connection} onRemove={() => onRemove(connection.key)} />
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
