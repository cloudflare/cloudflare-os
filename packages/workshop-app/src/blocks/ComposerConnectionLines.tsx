import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, DropdownMenu, useReducedMotion } from '@gadgets/ui'
import { CaretRightIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ServiceStack } from '@/components/ServiceStack'

/** What a connection waits on the user for: one thing to do, or one of several to choose. */
export type ComposerConnectionAsk =
  | { label: string; onAct: () => void; choices?: never }
  | { label: string; choices: readonly { id: string; label: string }[]; onChoose: (id: string) => void }

/** A connection added to a draft, which the chat has once the message goes. */
export type ComposerConnection = {
  key: string
  /** Which one it is: "cloudflare/gadgets", "Q3 forecast". */
  title: string
  /** What kind it is, as its service names it: "Repository". */
  kind?: string
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

// What kind it is, on its service: "GitHub repository", or "Google Doc" as it is named already.
const kindOf = ({ kind, service }: ComposerConnection) => {
  if (!kind) return service.name
  return kind.toLowerCase().startsWith(service.name.toLowerCase()) ? kind : `${service.name} ${kind.toLowerCase()}`
}

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

// More than this many, and those with nothing left to say are one line that opens to them.
const FOLD_OVER = 3

// The one thing a line offers to do, small enough for its line and plain against it.
const ASK = 'h-6 shrink-0 px-2.5 text-sm'

const LINE = 'flex h-9 items-center gap-2 rounded-[15px] bg-kumo-base ps-1 pe-1.5 text-sm ring-1 ring-kumo-line ring-inset'

// Whether a line has nothing left to say: made, and going with the draft.
const settled = ({ pending, problem, ask }: ComposerConnection) => !pending && !problem && !ask

const Line = ({ connection, refusal, onRemove }: { connection: ComposerConnection; refusal?: string; onRemove: () => void }) => {
  const { ask } = connection
  return (
    <div className={LINE}>
      <ServiceLogo name={connection.service.name} src={connection.service.logoUrl} glyph={connection.service.glyph} color={connection.service.color} tiny />
      <span className="sr-only">Adding the connection:</span>
      <span className="min-w-0 shrink truncate font-medium text-kumo-default">{connection.title}</span>
      {connection.problem
        ? <span role="alert" title={connection.problem} className="min-w-0 flex-1 truncate text-kumo-danger">{connection.problem}</span>
        : connection.pending
        ? <span role="status" className="min-w-0 flex-1 truncate text-kumo-subtle">Connecting…</span>
        : refusal
        ? <span role="alert" className="min-w-0 flex-1 truncate text-kumo-danger">{refusal}</span>
        : <span className="min-w-0 flex-1 truncate text-kumo-subtle">{connection.note ?? kindOf(connection)}</span>}
      {ask && (ask.choices
        ? (
            <DropdownMenu label={ask.label} caret keepTrigger triggerClassName={ASK} align="end">
              {ask.choices.map(({ id, label }) => <DropdownMenu.Item key={id} onSelect={() => ask.onChoose(id)}>{label}</DropdownMenu.Item>)}
            </DropdownMenu>
          )
        : <Button onClick={ask.onAct} className={ASK}>{ask.label}</Button>)}
      <Button
        variant="ghost"
        icon={<XIcon weight="bold" />}
        aria-label={`Don’t add ${connection.title}`}
        title={`Don’t add ${connection.title}`}
        onClick={onRemove}
        className="size-6 text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3"
      />
    </div>
  )
}

/**
 * The connections a draft goes with, each a line at the top of the composer the way a skill's is
 * (`ComposerCommandLine`): the service's logo, which one, and what kind, with the way to take it
 * off. Each opens and closes as that line does, and says in its place why it cannot go yet, when
 * it cannot: still connecting, why it could not be connected, or what it waits on the user for,
 * with that offered at its end. Past a few, those with nothing left to say are one line that
 * opens to them, so that what does wait on the user is never among many.
 */
export const ComposerConnectionLines = ({ connections, refusal, onRemove }: {
  connections: readonly ComposerConnection[]
  /** Why the draft cannot go with them as it is, such as a skill chosen, which goes alone. */
  refusal?: string
  onRemove: (key: string) => void
}) => {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION
  const [unfolded, setUnfolded] = useState(false)
  const done = connections.filter(settled)
  // Only where it saves room: two or more of them, among more than a few.
  const folds = connections.length > FOLD_OVER && done.length > 1
  const shown = folds && !unfolded ? connections.filter((connection) => !settled(connection)) : connections
  // Why it cannot go is said once, on the last line.
  const last = shown.at(-1)
  const services = [...new Map(done.map(({ service }) => [service.name, service])).values()]

  return (
    <AnimatePresence initial={false}>
      {folds && (
        <motion.div key="folded" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={transition} className="overflow-hidden">
          <div className="px-1.5 pt-1.5">
            <button
              type="button"
              aria-expanded={unfolded}
              onClick={() => setUnfolded((open) => !open)}
              className={cn(LINE, 'w-full cursor-pointer text-left hover:bg-kumo-tint')}
            >
              <ServiceStack services={services} label="On" />
              <span className="min-w-0 shrink truncate font-medium text-kumo-default">{done.length} connections</span>
              <span className="min-w-0 flex-1 truncate text-kumo-subtle">{refusal && shown.length === 0 ? refusal : 'going with this message'}</span>
              <CaretRightIcon aria-hidden="true" weight="bold" className={cn('me-1.5 size-3 shrink-0 text-kumo-subtle transition-transform motion-reduce:transition-none', unfolded && 'rotate-90')} />
            </button>
          </div>
        </motion.div>
      )}
      {shown.map((connection) => (
        <motion.div
          key={connection.key}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={transition}
          className="overflow-hidden"
        >
          <div className="px-1.5 pt-1.5">
            <Line connection={connection} refusal={connection === last ? refusal : undefined} onRemove={() => onRemove(connection.key)} />
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
