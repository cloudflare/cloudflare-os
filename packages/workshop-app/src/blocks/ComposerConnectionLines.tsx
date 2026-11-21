import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button, useReducedMotion } from '@gadgets/ui'
import { XIcon } from '@phosphor-icons/react'
import { ServiceLogo } from '@/components/ServiceLogo'

/** A connection added to a draft, which the chat has once the message goes. */
export type ComposerConnection = {
  key: string
  /** Which one it is: "cloudflare/gadgets", "Q3 forecast". */
  title: string
  /** What kind it is, as its service names it: "Repository". */
  kind?: string
  service: { name: string; logoUrl?: string; color?: string; glyph?: ReactNode }
  /** Still being made, from a link pasted into the draft: the draft cannot go until it is. */
  pending?: boolean
  /** Why it could not be made: it does not go with the draft, and says so until taken off. */
  problem?: string
}

// What kind it is, on its service: "GitHub repository", or "Google Doc" as it is named already.
const kindOf = ({ kind, service }: ComposerConnection) => {
  if (!kind) return service.name
  return kind.toLowerCase().startsWith(service.name.toLowerCase()) ? kind : `${service.name} ${kind.toLowerCase()}`
}

const TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const

/**
 * The connections a draft goes with, each a line at the top of the composer the way a skill's is
 * (`ComposerCommandLine`): the service's logo, which one, and what kind, with the way to take it
 * off. Each opens and closes as that line does, and says in its place why it cannot go yet, when
 * it cannot: still connecting, or why it could not be connected.
 */
export const ComposerConnectionLines = ({ connections, refusal, onRemove }: {
  connections: readonly ComposerConnection[]
  /** Why the draft cannot go with them as it is, such as a skill chosen, which goes alone. */
  refusal?: string
  onRemove: (key: string) => void
}) => {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION
  return (
    <AnimatePresence initial={false}>
      {connections.map((connection, at) => (
        <motion.div
          key={connection.key}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={transition}
          className="overflow-hidden"
        >
          <div className="px-1.5 pt-1.5">
            <div className="flex h-9 items-center gap-2 rounded-[15px] bg-kumo-base ps-1 pe-1.5 text-sm ring-1 ring-kumo-line ring-inset">
              <ServiceLogo name={connection.service.name} src={connection.service.logoUrl} glyph={connection.service.glyph} color={connection.service.color} tiny />
              <span className="sr-only">Adding the connection:</span>
              <span className="min-w-0 shrink truncate font-medium text-kumo-default">{connection.title}</span>
              {/* Why it cannot go is said once, on the last line. */}
              {connection.problem
                ? <span role="alert" title={connection.problem} className="min-w-0 flex-1 truncate text-kumo-danger">{connection.problem}</span>
                : connection.pending
                ? <span role="status" className="min-w-0 flex-1 truncate text-kumo-subtle">Connecting…</span>
                : refusal && at === connections.length - 1
                ? <span role="alert" className="min-w-0 flex-1 truncate text-kumo-danger">{refusal}</span>
                : <span className="min-w-0 flex-1 truncate text-kumo-subtle">{kindOf(connection)}</span>}
              <Button
                variant="ghost"
                icon={<XIcon weight="bold" />}
                aria-label={`Don’t add ${connection.title}`}
                title={`Don’t add ${connection.title}`}
                onClick={() => onRemove(connection.key)}
                className="size-6 text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default not-data-disabled:hover:bg-transparent [&>svg]:size-3"
              />
            </div>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
