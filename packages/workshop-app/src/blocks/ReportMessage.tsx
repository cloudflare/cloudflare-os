import { ArrowUpRightIcon } from '@phosphor-icons/react'
import { LinkButton } from '@/components/LinkButton'
import { Markdown } from '@/components/Markdown'
import { MessageBubble, type MessageDetails, type MessageJoins } from './MessageBubble'

export type ReportMessageProps = {
  /** The agent that ran, as it is called. */
  agentName: string
  text: string
  /** The run's own conversation, so that it can be opened in another tab. */
  href?: string
  /** Goes to the run's own conversation. */
  onOpenRun: () => void
  joins?: MessageJoins
  onReply?: () => void
  details?: MessageDetails
}

/**
 * What an agent the chat set up found on a run, posted here as the run ended: said by that agent,
 * so named above the bubble as anyone else is, with the way into the run that wrote it.
 */
export const ReportMessage = ({ agentName, text, href, onOpenRun, joins, onReply, details }: ReportMessageProps) => (
  <div className="flex flex-col gap-1">
    <span className="flex items-center gap-1.5 px-2 text-xs text-kumo-subtle">
      {agentName}
      <span aria-hidden="true">·</span>
      <LinkButton href={href} onClick={onOpenRun} className="inline-flex items-center gap-0.5 rounded-sm hover:text-kumo-default">
        See the run
        <ArrowUpRightIcon aria-hidden="true" weight="bold" className="size-3" />
      </LinkButton>
    </span>
    <MessageBubble role="assistant" joins={joins} onReply={onReply} copyText={text} details={details}>
      <Markdown>{text}</Markdown>
    </MessageBubble>
  </div>
)
