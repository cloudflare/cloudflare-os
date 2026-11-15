import { useId, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretRightIcon, CheckCircleIcon, ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ActionFields, type ActionField } from './ActionFields'
import { usePending, type ActionResult } from './usePending'

/** One change the gadget asks to make. */
export type GadgetAskRequest = {
  actionId: number
  title: string
  /** The gatekeeper's own account of what it does, as Markdown. */
  description: string
  fields: ActionField[]
}

/** Everything the gadget asks to do of one kind, through one connection: "Append to documents" in Q3 Budget. */
export type GadgetAskGroup = {
  key: string
  /** The kind, as the service names it, else what the one request is. */
  title: string
  /** Where, how many, and since when: "Q3 Budget · 2 waiting since 8:02". */
  detail: string
  /** The service it goes through, drawn by its logo; a shield for one with none. */
  service?: { name: string; logoUrl?: string; color?: string }
  /**
   * It can be allowed for good: its service lets this kind go ahead unasked. Otherwise, as for
   * sending or deleting, it is asked about every time.
   */
  allowable: boolean
  requests: GadgetAskRequest[]
  /**
   * Opens the file they change, drawn as it will be, to review them on it (`GadgetReview`), in
   * place of unfolding them here. Only for a file that can be drawn, such as a Google Doc.
   */
  onReview?: () => void
}

export type GadgetAskProps = {
  /** The gadget's name, as it asks. */
  gadgetTitle: string
  /** Who made it, when that is someone else: its code is theirs, and the viewer may not know it. */
  madeBy?: string
  groups: GadgetAskGroup[]
  /** Said once a kind was allowed, with the way to take it back. */
  notice?: { text: string; action?: { label: string; onClick: () => void } }
  /** Why the last decision did not go, with the rest left waiting. */
  problem?: string
  onDismissProblem?: () => void
  /** Lets it make changes of this kind from now on, and approves these. */
  onAllow: (key: string) => ActionResult
  /** Approves these, and asks again next time. */
  onAllowOnce: (key: string) => ActionResult
  onDeny: (key: string) => ActionResult
}

const EASE = [0.25, 0.1, 0.25, 1] as const
const ROW = { initial: { height: 0, opacity: 0 }, animate: { height: 'auto', opacity: 1 }, exit: { height: 0, opacity: 0 } }

const GroupIcon = ({ service }: { service?: GadgetAskGroup['service'] }) =>
  service ? (
    <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} />
  ) : (
    <span className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-kumo-fill text-kumo-default">
      <ShieldCheckIcon aria-hidden="true" className="size-4" />
    </span>
  )

const Group = ({ group, onAllow, onAllowOnce, onDeny }: {
  group: GadgetAskGroup
  onAllow: () => ActionResult
  onAllowOnce: () => ActionResult
  onDeny: () => ActionResult
}) => {
  const [pending, run] = usePending()
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-2xl bg-kumo-tint px-3 py-2.5">
      <div className="flex items-center gap-3">
        <GroupIcon service={group.service} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-title`} className="truncate text-base/5 text-kumo-default">{group.title}</span>
          <span className="truncate text-sm text-kumo-subtle">{group.detail}</span>
        </span>
        <button
          type="button"
          aria-expanded={group.onReview ? undefined : open}
          aria-controls={group.onReview ? undefined : `${id}-requests`}
          aria-haspopup={group.onReview ? 'dialog' : undefined}
          aria-describedby={group.onReview ? `${id}-title` : undefined}
          onClick={() => (group.onReview ? group.onReview() : setOpen(!open))}
          className="group/more flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-medium text-kumo-default outline-none hover:bg-kumo-fill focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          {group.onReview ? 'Review' : open ? 'Hide' : 'Details'}
          <CaretRightIcon
            aria-hidden="true"
            weight="bold"
            className={cn(
              'size-3 text-kumo-subtle transition-transform duration-200 motion-reduce:transition-none',
              group.onReview ? 'group-hover/more:translate-x-0.5' : open && 'rotate-90',
            )}
          />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && !group.onReview && (
          <motion.ul key="requests" id={`${id}-requests`} {...ROW} transition={{ duration: 0.2, ease: EASE }} className="flex flex-col gap-2 overflow-hidden">
            {group.requests.map((request) => (
              <li key={request.actionId} className="flex flex-col gap-1.5 rounded-xl bg-kumo-base px-3 py-2 ring-1 ring-kumo-line">
                <span className="text-sm font-medium text-kumo-default">{request.title}</span>
                {request.description && <div className="text-sm text-kumo-default"><Markdown>{request.description}</Markdown></div>}
                <ActionFields fields={request.fields} />
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!group.allowable && <span className="me-auto text-sm text-kumo-subtle">Asks every time</span>}
        <Button variant="ghost" disabled={pending} aria-describedby={`${id}-title`} onClick={() => run(onDeny)}>Don’t allow</Button>
        {group.allowable ? (
          <>
            <Button disabled={pending} aria-describedby={`${id}-title`} onClick={() => run(onAllowOnce)}>Only this time</Button>
            <Button variant="primary" disabled={pending} aria-describedby={`${id}-title`} onClick={() => run(onAllow)}>Always allow</Button>
          </>
        ) : (
          <Button variant="primary" disabled={pending} aria-describedby={`${id}-title`} onClick={() => run(onAllowOnce)}>Allow</Button>
        )}
      </div>
    </section>
  )
}

/**
 * What a gadget's own code asks to change through its connections, over the foot of the gadget,
 * the way the chat's tray sits over its composer: one row for each kind of change, said in the
 * service's words, with where and how many, and the three answers people know from their phones.
 * Always allow lets it make that kind of change from now on without asking, Only this time lets
 * these through, and Don’t allow drops them. A kind its service never lets through unasked, such
 * as sending, has only Allow, once, and says so. Changes to a file that can be drawn, such as a
 * Google Doc, are reviewed on the file (`onReview`); any other unfold here. Someone else's gadget says whose it is, since its
 * code is theirs. Rows close as they are decided, and the tray goes once nothing waits, leaving
 * what was allowed said for a moment, with the way to take it back.
 */
export const GadgetAsk = ({ gadgetTitle, madeBy, groups, notice, problem, onDismissProblem, onAllow, onAllowOnce, onDeny }: GadgetAskProps) => {
  const reduced = useReducedMotion()
  const transition = reduced ? { duration: 0 } : { duration: 0.24, ease: EASE }
  const showing = groups.length > 0 || problem !== undefined || notice !== undefined

  return (
    <AnimatePresence initial={false}>
      {showing && (
        <motion.section
          key="ask"
          aria-label={`${gadgetTitle} is asking`}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={transition}
          className="pointer-events-auto w-full origin-bottom overflow-hidden rounded-[21px] bg-kumo-base ring-1 ring-kumo-line shadow-[0_4px_16px_rgb(0_0_0/0.08)]"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {groups.length > 0 ? (
              <motion.header key="asking" {...ROW} transition={transition} className="flex items-center gap-2.5 overflow-hidden px-4 pt-2.5 pb-2">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-warning" />
                <span className="min-w-0">
                  <span className="block truncate text-base/5 font-medium text-kumo-default">{gadgetTitle} is asking</span>
                  <span className="block text-sm text-kumo-subtle">
                    {madeBy ? `Made by ${madeBy}. It asks before it does something new.` : 'It asks before it does something new.'}
                  </span>
                </span>
              </motion.header>
            ) : notice && (
              <motion.p key="notice" role="status" {...ROW} transition={transition} className="flex items-center gap-2.5 overflow-hidden px-4 py-2.5 text-sm text-kumo-default">
                <CheckCircleIcon aria-hidden="true" weight="fill" className="size-4 shrink-0 text-kumo-success" />
                <span className="min-w-0 flex-1">{notice.text}</span>
                {notice.action && (
                  <button type="button" className="shrink-0 font-medium text-kumo-default hover:underline" onClick={notice.action.onClick}>{notice.action.label}</button>
                )}
              </motion.p>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {problem && (
              <motion.div key="problem" {...ROW} transition={transition} className="overflow-hidden">
                <p role="alert" className="mx-2 mb-1.5 flex items-start gap-2 rounded-xl bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-default">
                  <WarningCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0 text-kumo-danger" />
                  <span className="min-w-0 flex-1">{problem}</span>
                  {onDismissProblem && <button type="button" className="shrink-0 font-medium text-kumo-default hover:underline" onClick={onDismissProblem}>Dismiss</button>}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {groups.length > 0 && (
            <ul className="flex max-h-[min(24rem,50vh)] flex-col overflow-y-auto overscroll-contain px-1.5">
              <AnimatePresence initial={false}>
                {groups.map((group) => (
                  <motion.li key={group.key} {...ROW} transition={transition} className="shrink-0 overflow-hidden pb-1.5">
                    <Group
                      group={group}
                      onAllow={() => onAllow(group.key)}
                      onAllowOnce={() => onAllowOnce(group.key)}
                      onDeny={() => onDeny(group.key)}
                    />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  )
}
