import { useId, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretRightIcon, ShieldWarningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Segmented } from '@/components/Segmented'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'

/** A kind of change a connection can make, and whether it goes ahead without asking. */
export type ChangeRuleKind = {
  tag: string
  /** As its gatekeeper names it: "Document edits, in any Doc this connection reaches". */
  label: string
  automatic: boolean
}

/** One of the workspace's connections through the account, and the kinds of change it can make on its own. */
export type ChangeRulesConnection = {
  gatekeeperId: number
  title: string
  kinds: ChangeRuleKind[]
}

export type ChangeRulesGroupProps = {
  workspace: { title: string; label: string }
  connections: ChangeRulesConnection[]
  /**
   * The workspace has read sensitive data, so every change asks whatever is chosen
   * (`WorkspaceMetadata.containsRestrictedData`): shown as asking, and not to be changed.
   */
  restricted?: boolean
  onChange: (gatekeeperId: number, tag: string, automatic: boolean) => void
  defaultOpen?: boolean
}

const EASE = [0.25, 0.1, 0.25, 1] as const

const CHOICES = [{ value: 'ask', label: 'Ask first' }, { value: 'auto', label: 'Automatic' }] as const

/**
 * A kind's label as a row says it: what it is, then how far it reaches, which gatekeepers write
 * after ", in ": "Document edits" and "In any Doc this connection reaches".
 */
export const kindLabel = (label: string): { title: string; reach?: string } => {
  const at = label.indexOf(', in ')
  if (at === -1) return { title: label }
  const reach = label.slice(at + 2)
  return { title: label.slice(0, at), reach: reach.charAt(0).toUpperCase() + reach.slice(1) }
}

/**
 * What a connected account may change on its own in one workspace: its name, and in a word how
 * much goes ahead without asking; opened, each kind of change its connections there can make, as
 * "Ask first" or "Automatic". A workspace that has read sensitive data asks before every change,
 * which it says, and nothing there can be made automatic.
 */
export const ChangeRulesGroup = ({ workspace, connections, restricted, onChange, defaultOpen = false }: ChangeRulesGroupProps) => {
  const [open, setOpen] = useState(defaultOpen)
  const reduced = useReducedMotion()
  const id = useId()
  const kinds = connections.flatMap(({ kinds }) => kinds)
  const automatic = restricted ? 0 : kinds.filter((kind) => kind.automatic).length
  const summary = automatic === 0 ? 'Asks before every change'
    : automatic === kinds.length ? 'Every change goes ahead'
    : `${automatic} of ${kinds.length} go ahead on their own`
  const many = connections.length > 1

  return (
    <section aria-labelledby={`${id}-title`} className="overflow-hidden rounded-3xl bg-kumo-tint">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-rules`}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-kumo-contrast/[0.03] focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-inset"
      >
        <WorkspaceIcon label={workspace.label} small />
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-title`} className="truncate text-base/5 font-medium text-kumo-default">{workspace.title}</span>
          <span className={cn('truncate text-sm', automatic > 0 ? 'text-kumo-default' : 'text-kumo-subtle')}>{summary}</span>
        </span>
        <CaretRightIcon
          aria-hidden="true"
          weight="bold"
          className={cn('size-3.5 shrink-0 text-kumo-subtle transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90')}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="rules"
            id={`${id}-rules`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.24, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="border-t border-kumo-line px-4">
              {restricted && (
                <p className="flex items-start gap-2 border-b border-kumo-line py-3 text-sm/5 text-kumo-subtle">
                  <ShieldWarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  This workspace has read sensitive data, so every change asks first here.
                </p>
              )}
              {connections.map((connection) => (
                <div key={connection.gatekeeperId} className="[&+&]:border-t [&+&]:border-kumo-line">
                  {many && <h3 className="pt-3 text-sm font-medium text-kumo-subtle">{connection.title}</h3>}
                  <ul className="[&>li+li]:border-t [&>li+li]:border-kumo-line">
                    {connection.kinds.map((kind) => {
                      const { title, reach } = kindLabel(kind.label)
                      const rowId = `${id}-${connection.gatekeeperId}-${kind.tag}`
                      return (
                        <li key={kind.tag} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                          <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                            <span id={`${rowId}-title`} className="text-base/5 text-kumo-default">{title}</span>
                            {reach && <span id={`${rowId}-reach`} className="text-sm/5 text-kumo-subtle">{reach}</span>}
                          </span>
                          <Segmented
                            aria-label={title}
                            aria-describedby={reach ? `${rowId}-reach` : undefined}
                            value={kind.automatic && !restricted ? 'auto' : 'ask'}
                            options={[...CHOICES]}
                            disabled={restricted}
                            onValueChange={(value) => onChange(connection.gatekeeperId, kind.tag, value === 'auto')}
                          />
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
