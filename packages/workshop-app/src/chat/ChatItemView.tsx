import { memo } from 'react'
import { ActionCard } from '@/blocks/ActionCard'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { ConnectionRequestCard } from '@/blocks/ConnectionRequestCard'
import { ErrorMessage } from '@/blocks/ErrorMessage'
import { FeedDivider } from '@/blocks/FeedDivider'
import { HookCard } from '@/blocks/HookCard'
import { messageInfo } from '@/blocks/messageInfo'
import { OutputCard } from '@/blocks/OutputCard'
import { SystemRow, type SystemRowProps } from '@/blocks/SystemRow'
import { UserMessage } from '@/blocks/UserMessage'
import type { ActionResult } from '@/blocks/usePending'
import type { ActionItem, ChatItem, NoticeItem } from './chatItems'
import { useOpenKeys, type DisclosureStore } from './DisclosureStore'

/** What the rows of a chat can ask for. One object for the whole chat, so rows are not rendered again for it. */
export type ChatItemHandlers = {
  onOpenAttachment: (attachmentId: string) => void
  onOpenOutput: (workpieceId: number) => void
  onApprove: (actionId: number) => ActionResult
  onDeny: (actionId: number) => ActionResult
  onAlwaysApprove: (rule: NonNullable<ActionItem['rule']>) => ActionResult
  onHookEnabledChange: (hookId: number, enabled: boolean) => ActionResult
  onSetUpConnection: (requestId: string) => ActionResult
  onDenyConnection: (requestId: string) => ActionResult
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
  gadget: 'plug',
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
  const open = useOpenKeys(disclosure, item.kind === 'assistant' ? [item.key, ...item.trace.map(({ key }) => key)] : [item.key])
  const isOpen = open.has(item.key)
  const toggle = () => disclosure.toggle(item.key)
  const joins = { above: joinsAbove, below: joinsBelow }

  switch (item.kind) {
    case 'user':
      return (
        <UserMessage
          parts={item.parts}
          attachments={item.attachments}
          from={item.from}
          unread={item.unread}
          onOpenAttachment={handlers.onOpenAttachment}
          joins={joins}
          details={{ open: isOpen, onToggle: toggle, ...messageInfo({ sender: item.from, sentAt: item.sentAt }) }}
        />
      )
    case 'assistant':
      return (
        <AssistantMessage
          text={item.text}
          joins={joins}
          details={{
            open: isOpen,
            onToggle: toggle,
            ...messageInfo({
              sender: item.sender,
              sentAt: item.sentAt,
              trace: { steps: item.trace, openSteps: open, onToggleStep: disclosure.toggle },
            }),
          }}
        />
      )
    case 'output':
      return (
        <OutputCard
          title={item.title}
          kind={item.type}
          draft={item.draft}
          format={item.format}
          onOpen={() => handlers.onOpenOutput(item.workpieceId)}
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
          onApprove={() => handlers.onApprove(item.actionId)}
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
      const request = { vendorName: item.vendorName, logoUrl: item.logoUrl, scope: item.scope, reason: item.reason }
      return item.state === 'pending'
        ? (
          <ConnectionRequestCard
            {...request}
            state="pending"
            onSetUp={() => handlers.onSetUpConnection(item.requestId)}
            onDeny={() => handlers.onDenyConnection(item.requestId)}
          />
        )
        : <ConnectionRequestCard {...request} state={item.state} />
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
