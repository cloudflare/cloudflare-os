import { useId, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CaretDownIcon, CaretRightIcon, CheckCircleIcon, ShieldCheckIcon, ShieldWarningIcon, WarningCircleIcon, WarningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ServiceLogo } from '@/components/ServiceLogo'
import { ActionFields, type ActionField } from './ActionFields'
import { usePending, type ActionResult } from './usePending'

/** One thing the gadget asks to do. */
export type GadgetAskRequest = {
  actionId: number
  title: string
  /** The gatekeeper's own account of what it does, as Markdown. */
  description: string
  fields: ActionField[]
}

/** Everything the gadget asks to do of one kind, through one connection: "Append to document" in Q3 notes. */
export type GadgetAskGroup = {
  key: string
  /** The kind, as the service names it, else what the one request is. */
  title: string
  /** Who asks, where, how many, and since when: "Q3 notes · 2 changes · asked 2 hours ago". */
  detail: string
  /** The service it goes through, drawn by its logo; a shield for one with none. */
  service?: { name: string; logoUrl?: string; color?: string }
  /**
   * It can be allowed for good: its service lets this kind go ahead unasked. Otherwise, as for
   * sending or deleting, it is asked about every time.
   */
  allowable: boolean
  /** It makes something in one of the viewer's accounts, which allowing it asks where. */
  creation?: boolean
  /** Part of what one of them will send is not in its description. */
  incomplete?: boolean
  requests: GadgetAskRequest[]
}

export type GadgetAskProps = {
  /** The gadget's name, as it asks. */
  gadgetTitle: string
  groups: GadgetAskGroup[]
  /**
   * The workspace has read sensitive data: each request is shown in full, to be read before it is
   * allowed, and nothing can be allowed for good.
   */
  restricted?: boolean
  /** Put away to its first line, which still says how much is asked, so that the gadget can be used under it. */
  folded: boolean
  onFoldedChange: (folded: boolean) => void
  /** Said once a kind was allowed for good, with the way to take it back. */
  notice?: { text: string; action?: { label: string; onClick: () => ActionResult } }
  /** Why the last decision did not go, with the rest left waiting. */
  problem?: string
  onDismissProblem?: () => void
  /** Lets it do this kind of thing from now on, and allows these. */
  onAllow: (key: string) => ActionResult
  /** Allows these, and asks again next time. */
  onAllowOnce: (key: string) => ActionResult
  onDeny: (key: string) => ActionResult
}

const EASE = [0.25, 0.1, 0.25, 1] as const
const ROW = { initial: { height: 0, opacity: 0 }, animate: { height: 'auto', opacity: 1 }, exit: { height: 0, opacity: 0 } }

const GroupIcon = ({ service }: { service?: GadgetAskGroup['service'] }) =>
  service ? (
    <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} small />
  ) : (
    <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-kumo-fill text-kumo-default">
      <ShieldCheckIcon aria-hidden="true" className="size-4" />
    </span>
  )

const Requests = ({ id, requests, uncapped }: { id: string; requests: GadgetAskRequest[]; uncapped?: boolean }) => (
  <ul id={id} className="flex flex-col gap-2">
    {requests.map((request) => (
      <li key={request.actionId} className="flex flex-col gap-1.5 rounded-xl bg-kumo-base px-3 py-2 ring-1 ring-kumo-line">
        <span className="text-sm font-medium wrap-break-word text-kumo-default">{request.title}</span>
        {request.description && <div className="text-sm text-kumo-default"><Markdown>{request.description}</Markdown></div>}
        <ActionFields fields={request.fields} uncapped={uncapped} />
      </li>
    ))}
  </ul>
)

const Group = ({ group, restricted, transition, onAllow, onAllowOnce, onDeny }: {
  group: GadgetAskGroup
  restricted: boolean
  transition: object
  onAllow: () => ActionResult
  onAllowOnce: () => ActionResult
  onDeny: () => ActionResult
}) => {
  const [pending, run] = usePending()
  const [open, setOpen] = useState(false)
  const id = useId()
  const allowable = group.allowable && !restricted && !group.creation
  // The requests are what the buttons act on, so they describe them while they are there to be read.
  const describedBy = [`${id}-title`, (restricted || open) && `${id}-requests`, group.incomplete && `${id}-incomplete`].filter(Boolean).join(' ')
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 rounded-2xl bg-kumo-tint px-3 py-2.5">
      <div className="flex items-center gap-3">
        <GroupIcon service={group.service} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-title`} className="truncate text-base/5 font-medium text-kumo-default">{group.title}</span>
          {group.detail && <span className="truncate text-sm text-kumo-subtle">{group.detail}</span>}
        </span>
        {!restricted && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-requests`}
            onClick={() => setOpen(!open)}
            className="flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-medium text-kumo-default outline-none hover:bg-kumo-fill focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            {open ? 'Hide' : 'Details'}
            <CaretRightIcon aria-hidden="true" weight="bold" className={cn('size-3 text-kumo-subtle transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90')} />
          </button>
        )}
      </div>
      {restricted ? (
        <Requests id={`${id}-requests`} requests={group.requests} uncapped />
      ) : (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div key="requests" {...ROW} transition={transition} className="overflow-hidden">
              <Requests id={`${id}-requests`} requests={group.requests} />
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {group.incomplete && (
        <p id={`${id}-incomplete`} role="note" className="flex items-start gap-2 text-sm text-kumo-default">
          <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kumo-warning" />
          Part of what this will send isn’t shown.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!allowable && !group.creation && !restricted && <span className="me-auto text-sm text-kumo-subtle">Asks every time</span>}
        <Button variant="ghost" disabled={pending} aria-describedby={describedBy} onClick={() => run(onDeny)}>Don’t allow</Button>
        {allowable ? (
          <>
            <Button disabled={pending} aria-describedby={describedBy} onClick={() => run(onAllowOnce)}>Only this time</Button>
            <Button variant="primary" disabled={pending} aria-describedby={describedBy} onClick={() => run(onAllow)}>Always allow</Button>
          </>
        ) : (
          <Button variant="primary" disabled={pending} aria-describedby={describedBy} onClick={() => run(onAllowOnce)}>
            {group.creation ? 'Allow…' : 'Allow'}
          </Button>
        )}
      </div>
    </section>
  )
}

/**
 * What a gadget asks to do through its connections, docked over the foot of the gadget wherever
 * it is shown (beside a chat, as its own page, in full screen), so that it is answered where the
 * gadget is, which goes on being used above it. One row for each kind of thing, said in the
 * service's words, with where, how many and since when, and the answers people know from their
 * phones: Always allow lets it do that kind of thing from now on without asking, Only this time
 * lets these through, and Don’t allow drops them. A kind its service never lets through unasked,
 * such as sending, has only Allow, and says it asks every time; one that makes something has
 * Allow…, which asks where. In a workspace that has read sensitive data each is shown in full and
 * nothing is allowed for good. It folds to its first line, which keeps saying how much is asked.
 * Rows close as they are decided, and the dock goes once nothing waits, leaving what was allowed
 * for good said for a moment, with the way to take it back.
 */
export const GadgetAsk = ({ gadgetTitle, groups, restricted = false, folded, onFoldedChange, notice, problem, onDismissProblem, onAllow, onAllowOnce, onDeny }: GadgetAskProps) => {
  const reduced = useReducedMotion() ?? false
  const transition = reduced ? { duration: 0 } : { duration: 0.24, ease: EASE }
  const id = useId()
  const count = groups.reduce((sum, group) => sum + group.requests.length, 0)
  const asking = groups.length > 0
  const showing = asking || problem !== undefined || notice !== undefined
  const [noticePending, runNotice] = usePending()

  return (
    <AnimatePresence initial={false}>
      {showing && (
        <motion.section
          key="ask"
          aria-labelledby={`${id}-title`}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
          transition={transition}
          className="pointer-events-auto flex max-h-full w-full origin-bottom flex-col overflow-hidden rounded-[1.375rem] bg-kumo-base shadow-lg ring-1 ring-kumo-contrast/6"
        >
          {asking ? (
            <header className="flex shrink-0 items-center gap-2.5 py-1.5 ps-4 pe-1.5">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-kumo-warning" />
              <span className="min-w-0 flex-1 py-1">
                <h2 id={`${id}-title`} className="truncate text-base/5 font-medium text-kumo-default">
                  {gadgetTitle} is asking{count > 1 ? ` · ${count}` : ''}
                </h2>
                {!folded && <span className="block text-sm text-kumo-subtle">It asks before it changes anything outside this workspace.</span>}
              </span>
              <Button
                variant="ghost"
                icon={<CaretDownIcon weight="bold" className={cn('transition-transform duration-200 motion-reduce:transition-none', folded && 'rotate-180')} />}
                aria-label={folded ? 'Show what it asks' : 'Put away for now'}
                aria-expanded={!folded}
                aria-controls={`${id}-groups`}
                onClick={() => onFoldedChange(!folded)}
                className="text-kumo-subtle"
              />
            </header>
          ) : (
            <h2 id={`${id}-title`} className="sr-only">{gadgetTitle}</h2>
          )}

          <AnimatePresence initial={false}>
            {notice && !asking && (
              <motion.p key="notice" role="status" {...ROW} transition={transition} className="flex shrink-0 items-center gap-2.5 overflow-hidden py-1.5 ps-4 pe-1.5 text-sm text-kumo-default">
                <CheckCircleIcon aria-hidden="true" weight="fill" className="size-4 shrink-0 text-kumo-success" />
                <span className="min-w-0 flex-1 py-2">{notice.text}</span>
                {notice.action && (
                  <Button variant="ghost" disabled={noticePending} onClick={() => runNotice(notice.action!.onClick)}>{notice.action.label}</Button>
                )}
              </motion.p>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {problem && (
              <motion.div key="problem" {...ROW} transition={transition} className="shrink-0 overflow-hidden">
                <p role="alert" className={cn('mx-1.5 flex items-start gap-2 rounded-2xl bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger', asking ? 'mb-1.5' : 'my-1.5')}>
                  <WarningCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1 wrap-break-word">{problem}</span>
                  {onDismissProblem && <button type="button" className="shrink-0 font-medium hover:underline" onClick={onDismissProblem}>Dismiss</button>}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {asking && restricted && !folded && (
            <p role="note" className="mx-1.5 mb-1.5 flex shrink-0 items-start gap-2 rounded-2xl bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-default">
              <ShieldWarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kumo-warning" />
              This workspace has read sensitive data. Read each request in full before allowing it: you are responsible for making sure it contains none of that data.
            </p>
          )}

          <AnimatePresence initial={false}>
            {asking && !folded && (
              <motion.ul
                key="groups"
                id={`${id}-groups`}
                {...ROW}
                transition={transition}
                className="flex min-h-0 flex-col overflow-y-auto overscroll-contain px-1.5"
              >
                <AnimatePresence initial={false}>
                  {groups.map((group) => (
                    <motion.li key={group.key} {...ROW} transition={transition} className="shrink-0 overflow-hidden pb-1.5">
                      <Group
                        group={group}
                        restricted={restricted}
                        transition={transition}
                        onAllow={() => onAllow(group.key)}
                        onAllowOnce={() => onAllowOnce(group.key)}
                        onDeny={() => onDeny(group.key)}
                      />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </motion.ul>
            )}
          </AnimatePresence>
        </motion.section>
      )}
    </AnimatePresence>
  )
}
