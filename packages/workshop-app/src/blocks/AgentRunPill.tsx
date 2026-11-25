import { cn } from '@cloudflare/kumo/utils'
import { LinkButton, useMotionTransition, type LinkButtonProps } from '@gadgets/ui'
import { AnimatePresence, motion } from 'motion/react'
import { AgentIcon } from '@/components/AgentIcon'
import { CARD_SURFACE } from '@/components/Card'
import { ArrowRight01Icon } from '@/components/icons'
import { RunStatusMark, type AgentRunStatus } from './RunStatusMark'

export type AgentRunPillProps = Omit<LinkButtonProps, 'onClick' | 'children'> & {
  /** Told of the click too, before it opens the run: for a menu whose item it is. */
  onClick?: LinkButtonProps['onClick']
  /** The run's title: what it was started to do. */
  title: string
  /** The agent it is a run of, by its name, before the title as a run's header has it. */
  agent?: string
  /**
   * How it stands: `started` where only that it started is said, its title trailing off
   * ("Processing tasks from Jira…"); while it works, a spinner at the end; otherwise, waiting on
   * the user or ended, its mark in the cloud's place.
   */
  status: AgentRunStatus | 'started'
  /** How it stands in words, "Finished", "Failed": read out after the title, as the mark says it. */
  statusWords: string
  /** Opens the run's conversation. Left out where it cannot be, when the pill is not pressed. */
  onOpen?: () => void
}

const EASE = [0.25, 0.1, 0.25, 1] as const
// How it changes as a run goes from one way of standing to another, the mark in the cloud's
// place fading over the cloud, and the spinner folding away at the end, the gap before it too.
const CHANGES = { duration: 0.3, ease: EASE }
const MARK_AWAY = { opacity: 0, scale: 0.5 }
const MARK_HERE = { opacity: 1, scale: 1 }
// While it is there, the spinner takes 2px of the pill's end (`pe-4`), to be as far from its
// edge as the cloud is from the other.
const SPINNER_AWAY = { width: 0, marginInlineStart: '-0.5rem', marginInlineEnd: '0rem', opacity: 0, scale: 0.5 }
const SPINNER_HERE = { width: 'auto', marginInlineStart: '0rem', marginInlineEnd: '-0.125rem', opacity: 1, scale: 1 }

/**
 * One agent's run as a pill, on a card's surface: the agent's cloud as an icon (still, as the mascot is not), the
 * agent's name and what the run was started to do, as its header has them, and how it stands, the
 * words for it only read out: one only started trails off, one at work has a spinner at the end,
 * and one that waits on the user or ended has its mark in the cloud's place. The title is cut
 * short before the name is. As the run stands otherwise, the mark fades over the cloud and the
 * spinner folds away. It opens the run's conversation, where it can be.
 * Whatever it is given beyond that goes to its button, so that a menu can draw its items as these.
 */
export const AgentRunPill = ({ title, agent, status, statusWords, onOpen, onClick, className, href, ...props }: AgentRunPillProps) => {
  const marked = status !== 'started' && status !== 'running'
  const changes = useMotionTransition(CHANGES)
  const look = cn(
    'inline-flex h-10 max-w-full min-w-0 items-center gap-2 rounded-full ps-3 text-left text-base text-kumo-default outline-none',
    CARD_SURFACE,
    onOpen && 'hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring data-highlighted:bg-kumo-tint',
    'pe-4',
    className,
  )
  const content = (
    <>
      <span className="grid shrink-0 *:[grid-area:1/1]">
        <AnimatePresence initial={false}>
          <motion.span key={marked ? status : 'agent'} initial={MARK_AWAY} animate={MARK_HERE} exit={MARK_AWAY} transition={changes} className="flex">
            {marked
              ? <RunStatusMark status={status} className="size-4.5" />
              : <AgentIcon weight="fill" className="size-4.5 shrink-0 text-kumo-default" />}
          </motion.span>
        </AnimatePresence>
      </span>
      {agent && (
        <>
          <span className="max-w-40 shrink-0 truncate text-kumo-subtle">{agent}</span>
          <ArrowRight01Icon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
          <span className="sr-only">, </span>
        </>
      )}
      <span className="min-w-0 truncate">{status === 'started' ? `${title}…` : title}</span>
      <span className="sr-only">, {statusWords}</span>
      <AnimatePresence initial={false}>
        {status === 'running' && (
          <motion.span key="spinner" initial={SPINNER_AWAY} animate={SPINNER_HERE} exit={SPINNER_AWAY} transition={changes} className="flex shrink-0 justify-center">
            <RunStatusMark status="running" className="size-4" />
          </motion.span>
        )}
      </AnimatePresence>
    </>
  )
  return onOpen ? (
    <LinkButton
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        onOpen()
      }}
      className={look}
    >
      {content}
    </LinkButton>
  ) : (
    <span {...props} className={look}>{content}</span>
  )
}
