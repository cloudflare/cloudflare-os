import { useEffect, useMemo, useRef, useState } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import { LiveRows } from '@/blocks/LiveRows'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList, type MessageListHandle } from '@/blocks/MessageList'
import { WorkLog } from '@/blocks/WorkLog'
import { Button } from '@/components/Button'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { ChatItemView, type ChatItemHandlers } from './ChatItemView'
import { continuesRun, EMPTY_FEED } from './chatItems'
import { DisclosureStore, useOpenKeys } from './DisclosureStore'
import { quoteLine, withQuote } from './replyQuote'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatSession } from './useChatSession'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
  /**
   * What this app cannot do itself yet, for whoever can. Left out, the chat says so when asked.
   * Keep each stable, or every row renders again.
   */
  onOpenOutput?: ChatItemHandlers['onOpenOutput']
  onSetUpConnection?: ChatItemHandlers['onSetUpConnection']
  onAlwaysApprove?: ChatItemHandlers['onAlwaysApprove']
}

const LIVE_WORK = 'live:work'

/** One chat, live: its title, the messages as they arrive, and the composer. */
export const ChatPane = ({ workspaceId, chatId, initialTitle, onOpenOutput, onSetUpConnection, onAlwaysApprove }: ChatPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  const model = useDefaultModel()
  const workspaces = useWorkspaces()
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  // What a row asked for that this app cannot do yet.
  const [notice, setNotice] = useState<string>()
  const [disclosure] = useState(() => new DisclosureStore())
  // The message the draft replies to: its row, and the line of it that will be quoted.
  const [reply, setReply] = useState<{ key: string; quote: string }>()
  const composer = useRef<ComposerHandle>(null)
  const list = useRef<MessageListHandle>(null)
  const work = chat.status === 'ready' ? chat.work : EMPTY_FEED.work
  const openWork = useOpenKeys(disclosure, [LIVE_WORK, ...work.map(({ key }) => key)])
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined
  const restricted = workspaces.status === 'ready' &&
    workspaces.workspaces.some(({ id, containsRestrictedData }) => id === workspaceId && containsRestrictedData === true)
  // The conversation as it stands, for what a row asks for that depends on the rows around it.
  // Read when asked, so that the rows' handlers do not change with every message.
  const conversation = useRef(items)
  useEffect(() => { conversation.current = items })

  const handlers = useMemo((): ChatItemHandlers => {
    const unavailable = (what: string) => () => setNotice(`${what} isn’t available in this app yet.`)
    return {
      onReply: (item) => {
        setReply({ key: item.key, quote: quoteLine(item) })
        composer.current?.focus()
      },
      // A reply only carries a line of what it answers (see replyQuote.ts), so the message is
      // found by that line: the nearest one before the reply that would be quoted the same.
      // Nothing happens when it is further back than has been loaded.
      onShowQuoted: (replying) => {
        const rows = conversation.current ?? []
        const at = rows.indexOf(replying)
        const quoted = rows.slice(0, at === -1 ? rows.length : at)
          .findLast((row) => (row.kind === 'user' || row.kind === 'assistant') && quoteLine(row) === replying.quote)
        if (quoted) list.current?.scrollToMessage(quoted.key)
      },
      // TODO: the attachment preview.
      onOpenAttachment: unavailable('Previewing attachments'),
      // TODO: open the workpiece in the output pane, once there is one.
      onOpenOutput: onOpenOutput ?? unavailable('Opening outputs'),
      onApprove: actions.approveAction,
      onDeny: actions.rejectAction,
      // TODO: confirm, then `Overseer.setAutoApprovedActionKind`, with the auto-approval settings.
      onAlwaysApprove: onAlwaysApprove ?? unavailable('Standing approvals'),
      onHookEnabledChange: actions.setHookEnabled,
      // TODO: the connect flow, which ends in `Overseer.acceptConnectionRequest`.
      onSetUpConnection: onSetUpConnection ?? unavailable('Setting up connections'),
      onDenyConnection: actions.denyConnection,
      onRetry: () => (model.status === 'ready' ? actions.retry(model.id) : setProblem(describeModelProblem(model))),
      // TODO: the add-credits flow.
      onContinue: unavailable('Adding credits'),
    }
  }, [actions, model, onOpenOutput, onSetUpConnection, onAlwaysApprove])


  const messages = useMemo(() => {
    // An artefact is shown at the end of its turn, after rows from later messages, so a row's
    // place in the conversation is the furthest sequence reached so far.
    let sequence = 0
    return items?.map((item, index) => {
      sequence = Math.max(sequence, item.id)
      return {
        id: item.key,
        sequence,
        content: (
          <ChatItemView
            item={item}
            disclosure={disclosure}
            handlers={handlers}
            restricted={restricted}
            // The list wraps every row, so messages in a run are told about each other.
            joinsAbove={continuesRun(items[index - 1], item)}
            joinsBelow={index + 1 < items.length && continuesRun(item, items[index + 1])}
          />
        ),
      }
    }) ?? []
  }, [items, disclosure, handlers, restricted])

  const sendMessage = (text: string) => {
    // Whoever says something is taken to where it will appear, and to what answers it, wherever
    // in the conversation they were reading. Only what others say waits for a reader who is not
    // at the end.
    list.current?.scrollToLatest()
    if (chat.status !== 'ready') return setProblem('The conversation is still loading. Try again in a moment.')
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setProblem(undefined)
    setNotice(undefined)
    setReply(undefined)
    void actions.send(reply ? withQuote(reply.quote, text) : text, model.id)
  }

  return (
    <ChatLayout
      header={title && <Button>{title}</Button>}
      composer={(
        <Composer
          ref={composer}
          onSend={sendMessage}
          reply={reply && {
            quote: reply.quote,
            onShow: () => list.current?.scrollToMessage(reply.key),
            onCancel: () => setReply(undefined),
          }}
        />
      )}
    >
      {chat.status === 'ready' && (
        <MessageList
          ref={list}
          messages={messages}
          streaming={chat.activity !== undefined}
          history={{ hasMore: chat.hasEarlier, loading: chat.loadingEarlier, error: chat.historyError, onLoadEarlier: actions.loadEarlier }}
        >
          {/* Under the conversation, so what an answer produced is never left behind by what is said
              after it. These come and go, each in a row that opens and closes around it. */}
          <LiveRows>
            {chat.pinned.map((item) => (
              <LiveRows.Row key={item.key}>
                <ChatItemView item={item} disclosure={disclosure} handlers={handlers} restricted={restricted} />
              </LiveRows.Row>
            ))}
            {chat.sendError && <LiveRows.Row key="send-error"><MessageBubble role="error">{chat.sendError}</MessageBubble></LiveRows.Row>}
            {chat.actionError && <LiveRows.Row key="action-error"><MessageBubble role="error">{chat.actionError}</MessageBubble></LiveRows.Row>}
            {problem && <LiveRows.Row key="problem"><MessageBubble role="error">{problem}</MessageBubble></LiveRows.Row>}
            {notice && <LiveRows.Row key="notice"><p role="status" className="px-2 text-sm text-kumo-subtle">{notice}</p></LiveRows.Row>}
          </LiveRows>
          {/* Last, in room that is always kept for it. A reply joins the conversation once it is
              written; until then it, and how it is coming about, can be looked into here. */}
          <AssistantPresence
            working={chat.activity !== undefined}
            status={chat.activity}
            details={{
              open: openWork.has(LIVE_WORK),
              onToggle: () => disclosure.toggle(LIVE_WORK),
              content: (
                <WorkLog steps={work} openSteps={openWork} onToggleStep={disclosure.toggle} />
              ),
            }}
          />
        </MessageList>
      )}
      {chat.status !== 'ready' && (
        <MessageList messages={[]}>
          {chat.status === 'failed'
            ? <MessageBubble role="error">{chat.message}</MessageBubble>
            : <span role="status" className="text-sm text-kumo-subtle">Loading conversation…</span>}
          {problem && <MessageBubble role="error">{problem}</MessageBubble>}
        </MessageList>
      )}
    </ChatLayout>
  )
}
