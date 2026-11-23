import { memo } from 'react'
import { AGENT_SPAWNER_CONNECTION_ID } from '@gadgets/workshop-shared/api'
import { ActionCard } from '@/blocks/ActionCard'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { ConnectionRequestCard } from '@/blocks/ConnectionRequestCard'
import { WebFetchRequestCard } from '@/blocks/WebFetchRequestCard'
import { ErrorMessage } from '@/blocks/ErrorMessage'
import { FeedDivider } from '@/blocks/FeedDivider'
import { HookCard } from '@/blocks/HookCard'
import { messageInfo, thinkingOf } from '@/blocks/messageInfo'
import { OutputCard } from '@/blocks/OutputCard'
import { SystemRow, type SystemRowProps } from '@/blocks/SystemRow'
import { UserMessage } from '@/blocks/UserMessage'
import type { ActionResult } from '@/blocks/usePending'
import { useDevMode } from '@/hooks/useDevMode'
import { useLiveWorkOpen } from '@/hooks/useLiveWorkOpen'
import type { ActionItem, AssistantItem, ChatAttachment, ChatItem, ConnectionItem, NoticeItem, OutputItem, UserItem } from './chatItems'
import { useOpenKeys, type DisclosureStore } from './DisclosureStore'

/** What the rows of a chat can ask for. One object for the whole chat, so rows are not rendered again for it. */
export type ChatItemHandlers = {
  /** A message as the server sent it, written out in full, where it can be. */
  rawMessage: (sequence: number) => string | undefined
  /** Start a reply to a message. */
  onReply: (item: UserItem | AssistantItem) => void
  /** Marks the chat unread from a message on. Left out where that is not the viewer's to do. */
  onMarkUnread?: (item: UserItem | AssistantItem) => void
  /** Go to the message a reply answers. */
  onShowQuoted: (reply: UserItem) => void
  onOpenAttachment: (attachment: ChatAttachment) => void
  /** Fetches a file sent in the chat, for a glimpse of it on its tile. */
  loadAttachment?: (id: string) => Promise<Uint8Array>
  onOpenOutput: (output: OutputItem) => void
  /** An output's own page, for its card to link to so that it can be opened in another tab. */
  outputHref?: (output: OutputItem) => string
  /** Approves it; one that creates something (`ActionItem.creation`) asks first where. */
  onApprove: (action: ActionItem) => ActionResult
  onDeny: (actionId: number) => ActionResult
  onAlwaysApprove: (rule: NonNullable<ActionItem['rule']>) => ActionResult
  onHookEnabledChange: (hookId: number, enabled: boolean) => ActionResult
  /** Sets up what an agent asked to be connected to (`SetUpConnection`). */
  onSetUpConnection: (request: ConnectionItem) => ActionResult
  onDenyConnection: (requestId: string) => ActionResult
  onApproveWebFetch: (requestIds: readonly string[]) => ActionResult
  onDenyWebFetch: (requestId: string) => ActionResult
  /** Sends what a view in an answer suggested, as the viewer's message; resolves to whether it went. */
  onSendSuggestion?: (message: string) => Promise<boolean>
  onRetry: () => ActionResult
  onContinue: () => ActionResult
}

export type ChatItemViewProps = {
  item: ChatItem
  disclosure: DisclosureStore
  handlers: ChatItemHandlers
  /** The workspace has read restricted data, which changes how an approval is presented. */
  restricted?: boolean
  /** The row carries on from the message before it, or is carried on by the one after (`continuesRun`). */
  joinsAbove?: boolean
  joinsBelow?: boolean
}

const NOTICE_ICONS: Record<NoticeItem['notice'], SystemRowProps['icon']> = {
  callback: 'code',
  unknown: 'info',
}

/**
 * One row of the conversation, as the block for its kind. Memoized: items keep their identity
 * while a reply streams in, so the conversation above it is not rendered again for every piece of
 * text that arrives.
 */
export const ChatItemView = memo(function ChatItemView({ item, disclosure, handlers, restricted, joinsAbove, joinsBelow }: ChatItemViewProps) {
  // A reply's row also remembers which steps behind it are open, for when its details are shown.
  const thinkingKey = `${item.key}:thinking`
  const open = useOpenKeys(disclosure, item.kind === 'assistant' ? [item.key, thinkingKey, ...item.trace.map(({ key }) => key)] : [item.key])
  const isOpen = open.has(item.key)
  const toggle = () => disclosure.toggle(item.key)
  const joins = { above: joinsAbove, below: joinsBelow }
  const devMode = useDevMode()
  // With thinking always shown, how a reply came about is open unless it was put away, as the one that
  // is alone starts out open in `WorkLog`.
  const [alwaysShowThinking] = useLiveWorkOpen()
  // In developer mode, what else a message's more menu copies.
  const developerCopies = devMode ? { id: String(item.id), json: () => handlers.rawMessage(item.id) } : undefined

  switch (item.kind) {
    case 'user':
      return (
        <UserMessage
          parts={item.parts}
          quote={item.quote}
          onShowQuoted={() => handlers.onShowQuoted(item)}
          attachments={item.attachments}
          from={item.from}
          unread={item.unread}
          onOpenAttachment={(id) => {
            const attachment = item.attachments.find((candidate) => candidate.id === id)
            if (attachment) handlers.onOpenAttachment(attachment)
          }}
          loadAttachment={handlers.loadAttachment}
          joins={joins}
          // One the agent has not read yet has no sequence to reply to.
          onReply={item.sentAt ? () => handlers.onReply(item) : undefined}
          onMarkUnread={handlers.onMarkUnread && (() => handlers.onMarkUnread?.(item))}
          developerCopies={developerCopies}
          details={{ open: isOpen, onToggle: toggle, ...messageInfo({ sender: item.from, sentAt: item.sentAt }) }}
        />
      )
    case 'assistant':
      return (
        <AssistantMessage
          text={item.text}
          parts={item.parts}
          onSendSuggestion={handlers.onSendSuggestion}
          joins={joins}
          onReply={() => handlers.onReply(item)}
          onMarkUnread={handlers.onMarkUnread && (() => handlers.onMarkUnread?.(item))}
          developerCopies={developerCopies}
          details={{
            open: isOpen,
            onToggle: toggle,
            ...messageInfo({
              sender: item.sender,
              sentAt: item.sentAt,
              reply: true,
              workedFor: devMode ? item.workedFor : undefined,
            }),
          }}
          thinking={item.trace.length > 0
            ? { open: open.has(thinkingKey) !== alwaysShowThinking, onToggle: () => disclosure.toggle(thinkingKey), content: thinkingOf({ steps: item.trace, openSteps: open, onToggleStep: disclosure.toggle }) }
            : undefined}
        />
      )
    case 'output':
      return (
        <OutputCard
          title={item.title}
          kind={item.type}
          draft={item.draft}
          format={item.format}
          href={handlers.outputHref?.(item)}
          onOpen={() => handlers.onOpenOutput(item)}
        />
      )
    case 'action': {
      const request = { title: item.title, description: item.description, resource: item.resource, fields: item.fields, open: isOpen, onToggle: toggle }
      if (item.state !== 'pending') {
        return <ActionCard {...request} state={item.state} resolution={item.resolution ?? ''} />
      }
      const { rule } = item
      return (
        <ActionCard
          {...request}
          state="pending"
          incomplete={item.incomplete}
          restricted={restricted}
          onApprove={() => handlers.onApprove(item)}
          onDeny={() => handlers.onDeny(item.actionId)}
          onAlwaysApprove={rule && (() => handlers.onAlwaysApprove(rule))}
        />
      )
    }
    case 'hook': {
      const { hookId } = item
      return (
        <HookCard
          title={item.title}
          description={item.description}
          resource={item.resource}
          enabled={item.enabled}
          onEnabledChange={hookId === undefined ? undefined : (enabled) => handlers.onHookEnabledChange(hookId, enabled)}
        />
      )
    }
    case 'connection': {
      // An agent is asked for as a connection is, under a name of the kernel's that nobody is told.
      const request = { vendorName: item.vendorName, agent: item.vendorId === AGENT_SPAWNER_CONNECTION_ID, logoUrl: item.logoUrl, scope: item.scope, reason: item.reason }
      return item.state === 'pending'
        ? (
          <ConnectionRequestCard
            {...request}
            state="pending"
            onSetUp={() => handlers.onSetUpConnection(item)}
            onDeny={() => handlers.onDenyConnection(item.requestId)}
          />
        )
        : <ConnectionRequestCard {...request} state={item.state} />
    }
    case 'webFetch': {
      if (item.state !== 'pending') return <WebFetchRequestCard url={item.url} state={item.state} />
      const { requestId, others } = item
      return (
        <WebFetchRequestCard
          url={item.url}
          state="pending"
          restricted={restricted}
          onApprove={() => handlers.onApproveWebFetch([requestId])}
          onDeny={() => handlers.onDenyWebFetch(requestId)}
          approveAll={others && { count: others.length + 1, onApprove: () => handlers.onApproveWebFetch([...others, requestId]) }}
        />
      )
    }
    case 'notice':
      return <SystemRow icon={NOTICE_ICONS[item.notice]} detail={item.detail}>{item.text}</SystemRow>
    case 'divider':
      return <FeedDivider>{item.label}</FeedDivider>
    case 'error':
      return (
        <ErrorMessage
          variant={item.usageLimit ? 'usageLimit' : 'error'}
          onRetry={item.recovery === 'retry' ? handlers.onRetry : undefined}
          onContinue={item.recovery === 'continue' ? handlers.onContinue : undefined}
        >
          {item.text}
        </ErrorMessage>
      )
  }
})
