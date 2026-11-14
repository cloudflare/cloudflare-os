import { useMemo, useRef, useState } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatHeader } from '@/blocks/ChatHeader'
import { KeepChangesCard } from '@/blocks/KeepChangesCard'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LiveRows } from '@/blocks/LiveRows'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList, type MessageListHandle } from '@/blocks/MessageList'
import { WorkLog } from '@/blocks/WorkLog'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ShareWorkspaceDialog } from '@/sharing/ShareWorkspaceDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { ChatItemView, type ChatItemHandlers } from './ChatItemView'
import { continuesRun, EMPTY_FEED, type ActionItem, type ChatItem, type OutputItem } from './chatItems'
import type { ChatSnapshot } from './ChatSession'
import { DisclosureStore, useOpenKeys } from './DisclosureStore'
import { nameGadgets, type GoBack } from './changePoints'
import { keepChangeLines, keepReason } from './keepChanges'
import { quoteLine, withQuote } from './replyQuote'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { useChatSession } from './useChatSession'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Opens the chat's settings, from its title. */
  onOpenSettings?: () => void
  /**
   * What the chat leaves to whoever can do it: opening a file or an output, which is for whoever
   * lays out the page it opens beside, and what this app cannot do itself yet. Left out, the chat
   * says so when asked. Keep each stable, or every row renders again.
   */
  onOpenAttachment?: ChatItemHandlers['onOpenAttachment']
  onOpenOutput?: ChatItemHandlers['onOpenOutput']
  outputHref?: ChatItemHandlers['outputHref']
  onSetUpConnection?: ChatItemHandlers['onSetUpConnection']
  onOpenChat?: ChatItemHandlers['onOpenChat']
  chatHref?: ChatItemHandlers['chatHref']
  /** The address of the chat's workspace, which sharing it copies. Left out, it is not shared from here. */
  workspaceLink?: string
}

const LIVE_WORK = 'live:work'

/** A gadget's title, as the chat's own cards for it have it: what the chat made, or worked on. */
const outputTitle = (items: readonly ChatItem[] | undefined, chat: ChatSnapshot, gadgetId: number) => {
  const pinned = chat.status === 'ready' ? chat.pinned : []
  return [...(items ?? []), ...pinned]
    .findLast((item): item is OutputItem => item.kind === 'output' && item.workpieceId === gadgetId)?.title
}

/** One chat, live: its title, the messages as they arrive, and the composer. */
export const ChatPane = ({
  workspaceId,
  chatId,
  initialTitle,
  onOpenWorkspace,
  onOpenSettings,
  onOpenAttachment,
  onOpenOutput,
  outputHref,
  onSetUpConnection,
  onOpenChat,
  chatHref,
  workspaceLink,
}: ChatPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  const model = useDefaultModel()
  const workspaces = useWorkspaces()
  const connection = useConnectionNotice()
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  // What a row asked for that this app cannot do yet.
  const [notice, setNotice] = useState<string>()
  const [disclosure] = useState(() => new DisclosureStore())
  // The message the draft replies to: its row, and the line of it that will be quoted.
  const [reply, setReply] = useState<{ key: string; quote: string }>()
  // The standing approval last asked about, kept while the question goes so that it still names it.
  const [asked, setAsked] = useState<{ rule: NonNullable<ActionItem['rule']>; open: boolean }>()
  // Undoing that would delete what it made, while that is asked about; kept as the question goes.
  const [deleting, setDeleting] = useState<{ point: GoBack; open: boolean }>()
  const composer = useRef<ComposerHandle>(null)
  const list = useRef<MessageListHandle>(null)
  const work = chat.status === 'ready' ? chat.work : EMPTY_FEED.work
  const openWork = useOpenKeys(disclosure, [LIVE_WORK, ...work.map(({ key }) => key)])
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const restricted = workspace?.containsRestrictedData === true
  const [sharing, setSharing] = useState(false)
  // Those who can only use what is in it cannot share it.
  const shareable = workspace !== undefined && workspace.role !== 'use' && workspaceLink !== undefined
  // Why the last message did not go, whether it was stopped here or by the server.
  const sendProblem = problem ?? (chat.status === 'ready' ? chat.sendError : undefined)
  useDocumentTitle(title ?? 'Chat')

  const handlers = useMemo((): ChatItemHandlers => {
    const unavailable = (what: string) => () => setNotice(`${what} isn’t available in this app yet.`)
    return {
      onReply: (item) => {
        setReply({ key: item.key, quote: quoteLine(item) })
        composer.current?.focus()
      },
      // The message may have had to be fetched. The list has its row by the next frame.
      onShowQuoted: (replying) => void actions.findQuoted(replying).then((key) => {
        if (key) requestAnimationFrame(() => list.current?.scrollToMessage(key))
      }),
      onOpenAttachment: onOpenAttachment ?? unavailable('Previewing attachments'),
      onOpenOutput: onOpenOutput ?? unavailable('Opening outputs'),
      outputHref,
      onApprove: actions.approveAction,
      onDeny: actions.rejectAction,
      // Asked first: it reaches past this action, to every chat and gadget in the workspace.
      onAlwaysApprove: (rule) => setAsked({ rule, open: true }),
      onHookEnabledChange: actions.setHookEnabled,
      // TODO: the connect flow, which ends in `Overseer.acceptConnectionRequest`.
      onSetUpConnection: onSetUpConnection ?? unavailable('Setting up connections'),
      onDenyConnection: actions.denyConnection,
      onRetry: () => (model.status === 'ready' ? actions.retry(model.id) : setProblem(describeModelProblem(model))),
      // TODO: the add-credits flow.
      onContinue: unavailable('Adding credits'),
      // Undoing what made a gadget deletes it, which is asked about first; anything else can be gone back on.
      onGoBack: (point) => (point.deletes.length ? setDeleting({ point, open: true }) : actions.goBack(point)),
      onOpenChat,
      chatHref,
    }
  }, [actions, model, onOpenAttachment, onOpenOutput, outputHref, onSetUpConnection, onOpenChat, chatHref])
  const keep = chat.status === 'ready' ? chat.keep : undefined


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

  // Resolves to whether the message went; until it has, the draft and what it replies to stay.
  const sendMessage = async (text: string, files: File[]) => {
    // Whoever says something is taken to where it will appear, and to what answers it, wherever
    // in the conversation they were reading. Only what others say waits for a reader who is not
    // at the end.
    list.current?.scrollToLatest()
    if (chat.status !== 'ready') {
      if (!connection?.blocked()) setProblem('The conversation is still loading. Try again in a moment.')
      return false
    }
    if (model.status !== 'ready') {
      setProblem(describeModelProblem(model))
      return false
    }
    setProblem(undefined)
    setNotice(undefined)
    const replied = reply
    const sent = await actions.send(replied ? withQuote(replied.quote, text) : text, model.id, files)
    // Unless another message has been chosen to reply to meanwhile.
    if (sent) setReply((current) => (current === replied ? undefined : current))
    return sent
  }

  return (
    <ChatLayout
      header={(workspace || title) && (
        <ChatHeader
          workspace={workspace && { id: workspaceId, title: workspace.title, label: workspaceLabel(workspace.title), onOpen: onOpenWorkspace }}
          title={title}
          onOpenSettings={onOpenSettings}
          onShare={shareable ? () => setSharing(true) : undefined}
        />
      )}
      composer={(
        <Composer
          ref={composer}
          onSend={sendMessage}
          stop={chat.status === 'ready' && chat.agentActive ? {
            waiting: chat.waiting,
            onStop: () => {
              if (connection?.blocked()) return false
              setProblem(undefined)
              actions.dismissSendError()
              return actions.stopAgent().catch((error: unknown) => {
                setProblem(`The agent couldn’t be stopped: ${error instanceof Error ? error.message : String(error)}`)
                throw error
              })
            },
          } : undefined}
          problem={sendProblem === undefined ? undefined : {
            message: sendProblem,
            onDismiss: () => {
              setProblem(undefined)
              actions.dismissSendError()
            },
          }}
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
            {keep && (
              <LiveRows.Row key="keep">
                <KeepChangesCard
                  changes={keepChangeLines(keep, (gadgetId) => outputTitle(items, chat, gadgetId))}
                  reason={keepReason(keep)}
                  onKeep={actions.keepChanges}
                  onDiscard={actions.discardChanges}
                />
              </LiveRows.Row>
            )}
            {chat.actionError && <LiveRows.Row key="action-error"><MessageBubble role="error">{chat.actionError}</MessageBubble></LiveRows.Row>}
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
            : <span role="status" className="appears-late text-sm text-kumo-subtle">Loading conversation…</span>}
        </MessageList>
      )}
      <ConfirmDialog
        open={deleting?.open === true}
        onOpenChange={(open) => setDeleting((current) => current && { ...current, open })}
        destructive
        title={`Undo creating ${nameGadgets(deleting?.point.deletes.map((id) => outputTitle(items, chat, id)) ?? [])}?`}
        description="What this made is deleted, with everything it stored, and can’t be brought back."
        confirm="Undo and delete"
        onConfirm={() => (deleting ? actions.goBack(deleting.point) : undefined)}
      />
      <ConfirmDialog
        open={asked?.open === true}
        onOpenChange={(open) => setAsked((current) => current && { ...current, open })}
        title={`Always approve “${asked?.rule.actionKind.label}”?`}
        description="From now on these go ahead without asking, in every chat in this workspace and whichever gadget asks. Any waiting now go ahead too."
        confirm="Always approve"
        onConfirm={() => (asked ? actions.alwaysApprove(asked.rule) : undefined)}
      />
      {shareable && <ShareWorkspaceDialog workspaceId={workspaceId} title={workspace.title} link={workspaceLink} open={sharing} onOpenChange={setSharing} />}
    </ChatLayout>
  )
}
