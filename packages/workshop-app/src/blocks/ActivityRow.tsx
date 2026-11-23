import { useId, type ReactNode } from 'react'
import {
  ArrowRight01Icon, CancelCircleIcon, CheckmarkCircle02Icon, FlashIcon, HandIcon, HistoryClockwiseIcon,
  MessageCircleIcon, ViewIcon,
} from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { Markdown } from '@gadgets/ui'
import { ActionFields, type ActionField } from './ActionFields'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'

/** What became of it: an action waiting, approved by a person or a rule, or denied; something read; an automation. */
export type ActivityRowOutcome = 'waiting' | 'approved' | 'auto' | 'denied' | 'read' | 'automation'

export type ActivityRowProps = {
  outcome: ActivityRowOutcome
  title: string
  /** How it stands, in a few words, at the row's end: "Approved by Ada". */
  status: string
  /** When it last changed, as a list says it: "5 min ago", "Yesterday". */
  time?: string
  resource?: ResourceLinkProps
  /** The chat it was asked for in, where it says. */
  chat?: string
  open: boolean
  onToggle: () => void
  /** What it did, sent or read, as Markdown and fields, shown once it is opened. */
  description: string
  fields: ActionField[]
  /** When it was asked for and decided, in full, shown once it is opened. */
  when?: string
  /** The ways on from it, once opened: to its chat, to what waits. */
  links?: ReactNode
}

const MARKS: Record<ActivityRowOutcome, { Icon: typeof CheckmarkCircle02Icon; colour: string; words: string }> = {
  waiting: { Icon: HandIcon, colour: 'text-kumo-warning', words: 'text-kumo-warning' },
  approved: { Icon: CheckmarkCircle02Icon, colour: 'text-kumo-success', words: 'text-kumo-subtle' },
  auto: { Icon: FlashIcon, colour: 'text-kumo-subtle', words: 'text-kumo-subtle' },
  denied: { Icon: CancelCircleIcon, colour: 'text-kumo-danger', words: 'text-kumo-danger' },
  read: { Icon: ViewIcon, colour: 'text-kumo-subtle', words: 'text-kumo-subtle' },
  automation: { Icon: HistoryClockwiseIcon, colour: 'text-kumo-subtle', words: 'text-kumo-subtle' },
}

/**
 * One entry of a workspace's history, as a line of a log, in the overview's columns: a mark of
 * what became of it, what it was and how it stands (in the colour of what wants a look), the chat
 * it was in, and when. It opens in place to what it did or read and at what, when, and the way to
 * the chat.
 */
export const ActivityRow = ({ outcome, title, status, time, resource, chat, open, onToggle, description, fields, when, links }: ActivityRowProps) => {
  const { Icon, colour, words } = MARKS[outcome]
  const id = useId()
  return (
    <div className={cn('flex flex-col rounded-[1.125rem] has-focus-visible:bg-kumo-contrast/5', open ? 'my-1 bg-kumo-base ring-1 ring-kumo-line' : 'hover:bg-kumo-contrast/5')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? `${id}-details` : undefined}
        onClick={onToggle}
        className="flex h-10 w-full cursor-pointer items-center gap-3 rounded-[1.125rem] px-3 text-left text-base outline-none"
      >
        <span className="grid w-5 shrink-0 place-items-center">
          <Icon aria-hidden="true" weight={outcome === 'read' || outcome === 'automation' ? 'regular' : 'bold'} className={cn('size-4', colour)} />
        </span>
        <span className="min-w-0 flex-1 truncate text-kumo-default">{title}</span>
        <span className={cn('w-28 shrink-0 truncate text-sm sm:w-44', words)}>{status}</span>
        <span className="flex w-48 shrink-0 items-center gap-1.5 text-sm text-kumo-subtle max-md:hidden">
          {chat && <MessageCircleIcon aria-hidden="true" className="size-4 shrink-0" />}
          <span className="truncate">{chat}</span>
        </span>
        <span className="w-24 shrink-0 truncate text-end text-sm text-kumo-subtle">{time}</span>
        <ArrowRight01Icon aria-hidden="true" weight="bold" className={cn('size-3 shrink-0 text-kumo-subtle transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
      </button>
      {open && (
        <div id={`${id}-details`} className="flex flex-col gap-3 px-3 pb-3 md:ps-11">
          {(resource || chat) && (
            <span className="text-sm text-kumo-subtle">
              {resource?.title}
              {resource && chat && <span className="md:hidden"> · </span>}
              {chat && <span className="md:hidden">in “{chat}”</span>}
            </span>
          )}
          {description && <div className="text-sm text-kumo-default"><Markdown>{description}</Markdown></div>}
          <ActionFields fields={fields} />
          {(when || resource?.url) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-subtle">
              {when && <span>{when}</span>}
              {resource?.url && <ResourceLink {...resource} />}
            </div>
          )}
          {links && <div className="flex flex-wrap gap-2">{links}</div>}
        </div>
      )}
    </div>
  )
}
