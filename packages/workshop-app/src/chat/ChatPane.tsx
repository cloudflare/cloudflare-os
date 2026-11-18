import { useEffect, useMemo, useRef, useState } from 'react'
import { hooksShownIn } from '@/automations/automations'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatHeader } from '@/blocks/ChatHeader'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import { DeleteChatDialog } from '@/blocks/DeleteChatDialog'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import { AddConnection, type AddedConnection } from '@/connections/AddConnection'
import { KeepChangesCard } from '@/blocks/KeepChangesCard'
import { LiveRows } from '@/blocks/LiveRows'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList, type MessageListHandle } from '@/blocks/MessageList'
import { WorkLog } from '@/blocks/WorkLog'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useHandler } from '@/hooks/useHandler'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { OutOfCredits } from '@/settings/OutOfCredits'
import { messageOf } from '@/settings/useAttempt'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { notificationChoices, notificationsOf } from './ChatNotifications'
import { ChatItemView, type ChatItemHandlers } from './ChatItemView'
import { continuesRun, EMPTY_FEED, outOfCreditsAt, type ActionItem, type ChatItem, type OutputItem } from './chatItems'
import { DisclosureStore, useOpenKeys } from './DisclosureStore'
import { keepChangeLines, keepReason } from './keepChanges'
import { bindingKey, useBindingTitles } from './useBindingTitles'
import { quoteLine, withQuote } from './replyQuote'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { slashRequestFor, missingCommand } from './slashCommands'
import { useChatCommands } from './useChatCommands'
import { withCapsules } from './capsules'
import { useLinkConnections } from './useLinkConnections'
import { useChatNotifications } from './useChatNotifications'
import { useChatSession } from './useChatSession'
import { useDeleteChat } from './useDeleteChat'
import { useOpenNewOutputs } from './useOpenNewOutputs'
import { useCapturedLogs } from './useCapturedLogs'
import { CapturedLogsChip } from '@/blocks/CapturedLogsChip'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Opens the chat's settings, from its title, or at what it set up to run by itself, from the header's clock. */
  onOpenSettings?: (tab?: 'automations') => void
  /**
   * What the chat leaves to whoever can do it: opening a file or an output, which is for whoever
   * lays out the page it opens beside, and what this app cannot do itself yet. Left out, the chat
   * says so when asked. Keep each stable, or every row renders again.
   */
  onOpenAttachment?: ChatItemHandlers['onOpenAttachment']
  onOpenOutput?: ChatItemHandlers['onOpenOutput']
  outputHref?: ChatItemHandlers['outputHref']
  onSetUpConnection?: ChatItemHandlers['onSetUpConnection']
  onAlwaysApprove?: ChatItemHandlers['onAlwaysApprove']
  /**
   * Approves an action that creates something (`ActionItem.creation`), asking where. Left out,
   * it is approved as any other, which the workspace refuses. Rejects with why it was not made.
   */
  onApproveCreation?: (action: ActionItem & { creation: { gatekeeperId: number } }) => Promise<void>
  /**
   * The chat was deleted, here or by anyone else in the workspace: go somewhere else, in place of
   * it in the history, so that going back does not come back to it.
   */
  onDeleted: () => void
}

const LIVE_WORK = 'live:work'

// A gadget by the title the chat shows its output under, where it shows one.
const outputTitle = (items: readonly ChatItem[], gadgetId: number) =>
  items.find((item): item is OutputItem => item.kind === 'output' && item.workpieceId === gadgetId)?.title

/** One chat, live: its title, the messages as they arrive, and the composer. */
const NO_BINDINGS: { gadgetId: number; name: string }[] = []

export const ChatPane = ({ workspaceId, chatId, initialTitle, onOpenWorkspace, onOpenSettings, onOpenAttachment, onOpenOutput, outputHref, onSetUpConnection, onAlwaysApprove, onApproveCreation, onDeleted }: ChatPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  // What the bindings it waits to keep reach, by the names people know them by.
  const keepBindings = useBindingTitles(workspaceId, chatId, chat.status === 'ready' ? chat.keep?.changes.bindings ?? NO_BINDINGS : NO_BINDINGS)
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
  const composer = useRef<ComposerHandle>(null)
  const list = useRef<MessageListHandle>(null)
  const work = chat.status === 'ready' ? chat.work : EMPTY_FEED.work
  const openWork = useOpenKeys(disclosure, [LIVE_WORK, ...work.map(({ key }) => key)])
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined
  // What the chat's cards show it set up to run by itself and was not deleted, for the header's clock.
  const pinned = chat.status === 'ready' ? chat.pinned : undefined
  const automations = useMemo(() => hooksShownIn([...(items ?? []), ...(pinned ?? [])]).length, [items, pinned])
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  const restricted = workspace?.containsRestrictedData === true
  // The way on once the credits ran out: opened by Continue, and by itself once for each time
  // they ran out, by the row that says so, as the old app did. Put away, it stays away for that row.
  const ranOut = items && outOfCreditsAt(items)
  const [creditsShown, setCreditsShown] = useState<{ open: boolean; seen?: string }>({ open: false })
  const outOfCredits = creditsShown.open || (ranOut !== undefined && ranOut !== creditsShown.seen)
  // Add a connection is open; and the connections made for the draft, by their line's key.
  const [adding, setAdding] = useState(false)
  const added = useRef(new Map<string, AddedConnection>())
  // One made from the menu: the chat has it once the message goes with it. Stable, as it uses
  // only refs, so that the dialog is not drawn again for each word of a reply.
  const [onAdded] = useState(() => async (made: AddedConnection) => {
    const key = `gatekeeper:${made.gatekeeperId}`
    added.current.set(key, made)
    composer.current?.addConnection({ key, title: made.description.title, kind: made.kind, service: made.service })
  })
  // Making a connection in the workspace is building in it, which those who only use it cannot.
  const builds = workspace !== undefined && workspace.role !== 'use'
  const pasteLinks = useLinkConnections(builds ? workspaceId : undefined, composer, added)
  // Its notifications and deleting it are for whoever builds there too: someone who can only use
  // the workspace has no chats of it.
  const notifications = useChatNotifications(workspaceId, builds)
  const deleteChat = useDeleteChat(workspaceId)
  const [deleting, setDeleting] = useState(false)
  // Left once, whether the workspace says it was deleted first or the call returns first.
  const left = useRef(false)
  const leave = () => {
    if (left.current) return
    left.current = true
    onDeleted()
  }
  const gone = chat.status === 'deleted'
  // The workspace's word, which is also how a chat deleted by someone else is left.
  useEffect(() => {
    if (gone) leave()
  })
  // Why the last message did not go, whether it was stopped here or by the server.
  const sendProblem = problem ?? (chat.status === 'ready' ? chat.sendError : undefined)
  useDocumentTitle(title ?? 'Chat')
  const commands = useChatCommands(actions.listCommands, chat.status === 'ready')
  useOpenNewOutputs(chat.status === 'ready' ? chat : undefined, onOpenOutput)

  // What a view in an answer suggested, once the viewer clicked Send under it: a message of their
  // own, as from the composer, but replying to nothing, and leaving the draft as it is.
  const sendSuggestion = useHandler(async (message: string) => {
    list.current?.scrollToLatest()
    if (chat.status !== 'ready') return false
    if (model.status !== 'ready') {
      setProblem(describeModelProblem(model))
      return false
    }
    setProblem(undefined)
    return actions.send(message, model.id)
  })

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
      loadAttachment: actions.attachmentContent,
      onOpenOutput: onOpenOutput ?? unavailable('Opening outputs'),
      outputHref,
      onApprove: (action) => {
        const { creation } = action
        if (!creation || !onApproveCreation) return actions.approveAction(action.actionId)
        return onApproveCreation({ ...action, creation }).catch((error: unknown) => setNotice(messageOf(error)))
      },
      onDeny: actions.rejectAction,
      onAlwaysApprove: onAlwaysApprove ?? actions.alwaysApprove,
      onHookEnabledChange: actions.setHookEnabled,
      onSetUpConnection: onSetUpConnection ?? unavailable('Setting up connections'),
      onDenyConnection: actions.denyConnection,
      onApproveWebFetch: actions.approveWebFetches,
      onDenyWebFetch: actions.denyWebFetch,
      onSendSuggestion: sendSuggestion,
      onRetry: () => (model.status === 'ready' ? actions.retry(model.id) : setProblem(describeModelProblem(model))),
      onContinue: () => setCreditsShown((shown) => ({ ...shown, open: true })),
    }
  }, [actions, model, onOpenAttachment, onOpenOutput, outputHref, onSetUpConnection, onAlwaysApprove, onApproveCreation, sendSuggestion])


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
  const sendMessage = useHandler(async (text: string, files: File[], command?: ComposerCommand, connections?: ComposerConnection[]) => {
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
    const words = replied ? withQuote(replied.quote, text) : text
    // A skill or command goes as the workspace offers it, given the words; one it no longer
    // offers, such as a skill deleted since, does not go.
    const request = command && slashRequestFor(commands.choices, command, words)
    if (command && !request) {
      setProblem(missingCommand(command))
      return false
    }
    // The connections after the words, each where its capsule shows it.
    const given = connections?.flatMap(({ key }) => added.current.get(key) ?? []) ?? []
    const { text: written, capsules } = withCapsules(words, given)
    const sent = await actions.send(request ?? written, model.id, files, capsules.length ? capsules : undefined)
    // Unless another message has been chosen to reply to meanwhile.
    if (sent) setReply((current) => (current === replied ? undefined : current))
    return sent
  })

  // The header and the composer are drawn again only for what they show. The chat renders for
  // every piece of a reply that streams in, and they are most of what it would draw again then.
  const ready = chat.status === 'ready'
  const notificationsRow = notifications.rows.get(chatId)
  const requireParticipation = ready && chat.notificationsRequireParticipation
  const openSettings = useHandler((tab?: 'automations') => onOpenSettings?.(tab))
  const openWorkspace = useHandler(onOpenWorkspace)
  const changeNotifications = useHandler((enabled: boolean) => {
    setNotice(undefined)
    if (connection?.blocked()) return
    notifications.setEnabled(chatId, enabled).catch((error: unknown) => setNotice(`Couldn’t change the chat’s notifications: ${messageOf(error)}`))
  })
  const hasSettings = onOpenSettings !== undefined
  const workspaceTitle = workspace?.title
  const header = useMemo(() => (workspaceTitle !== undefined || title) && (
    <ChatHeader
      workspace={workspaceTitle !== undefined ? { id: workspaceId, title: workspaceTitle, label: workspaceLabel(workspaceTitle), look, onOpen: openWorkspace } : undefined}
      title={title}
      onOpenSettings={hasSettings ? () => openSettings() : undefined}
      automations={automations > 0 && hasSettings ? { count: automations, onOpen: () => openSettings('automations') } : undefined}
      more={builds && ready ? {
        notifications: {
          choices: notificationChoices(notificationsOf(notificationsRow, requireParticipation)),
          onChange: changeNotifications,
        },
        onDelete: () => setDeleting(true),
      } : undefined}
    />
  ), [workspaceTitle, title, workspaceId, look, openWorkspace, hasSettings, openSettings, automations, builds, ready, notificationsRow, requireParticipation, changeNotifications])

  const onPasteLinks = useHandler((urls: string[]) => pasteLinks?.(urls))
  const hasPasteLinks = pasteLinks !== undefined
  const stopAgent = useHandler(() => {
    if (connection?.blocked()) return false
    setProblem(undefined)
    actions.dismissSendError()
    return actions.stopAgent().catch((error: unknown) => {
      setProblem(`The agent couldn’t be stopped: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    })
  })
  const dismissProblem = useHandler(() => {
    setProblem(undefined)
    actions.dismissSendError()
  })
  const showReplied = useHandler(() => {
    if (reply) list.current?.scrollToMessage(reply.key)
  })
  const agentActive = ready && chat.agentActive
  const waiting = ready ? chat.waiting : undefined
  const composerCommands = commands.commands
  const { summary: logged, take: takeLogs, peek: peekLogs, discard: discardLogs } = useCapturedLogs(workspaceId, chatId)
  const addLogs = useHandler(() => {
    const text = takeLogs()
    if (text) composer.current?.appendToDraft(text)
  })
  const composerElement = useMemo(() => (
    <div className="flex flex-col gap-2">
    <CapturedLogsChip
      count={logged.count}
      severity={logged.severity}
      preview={logged.count ? peekLogs() : undefined}
      onAdd={addLogs}
      onDiscard={discardLogs}
    />
    <Composer
      ref={composer}
      onSend={sendMessage}
      commands={composerCommands}
      onPasteLinks={hasPasteLinks ? onPasteLinks : undefined}
      addActions={builds ? { onAddConnection: () => setAdding(true) } : undefined}
      stop={agentActive && waiting ? { waiting, onStop: stopAgent } : undefined}
      problem={sendProblem === undefined ? undefined : { message: sendProblem, onDismiss: dismissProblem }}
      reply={reply && { quote: reply.quote, onShow: showReplied, onCancel: () => setReply(undefined) }}
    />
    </div>
  ), [logged, peekLogs, discardLogs, addLogs, sendMessage, composerCommands, hasPasteLinks, onPasteLinks, builds, agentActive, waiting, stopAgent, sendProblem, dismissProblem, reply, showReplied])

  const confirmDelete = useHandler(async () => {
    if (connection?.blocked()) return
    await deleteChat(chatId)
    leave()
  })
  const chatTitle = title || 'Untitled chat'
  const deleteDialog = useMemo(() => (
    <DeleteChatDialog open={deleting && !gone} onOpenChange={setDeleting} title={chatTitle} onConfirm={confirmDelete} />
  ), [deleting, gone, chatTitle, confirmDelete])

  const hasEarlier = ready && chat.hasEarlier
  const loadingEarlier = ready && chat.loadingEarlier
  const historyError = ready ? chat.historyError : undefined
  const history = useMemo(
    () => ({ hasMore: hasEarlier, loading: loadingEarlier, error: historyError, onLoadEarlier: actions.loadEarlier }),
    [hasEarlier, loadingEarlier, historyError, actions.loadEarlier],
  )

  return (
    <ChatLayout
      header={header}
      composer={composerElement}
    >
      {chat.status === 'ready' && (
        <MessageList
          ref={list}
          messages={messages}
          streaming={chat.activity !== undefined}
          history={history}
        >
          {/* Under the conversation, so what an answer produced is never left behind by what is said
              after it. These come and go, each in a row that opens and closes around it. */}
          <LiveRows>
            {chat.pinned.map((item) => (
              <LiveRows.Row key={item.key}>
                <ChatItemView item={item} disclosure={disclosure} handlers={handlers} restricted={restricted} />
              </LiveRows.Row>
            ))}
            {chat.keep && (
              <LiveRows.Row key="keep">
                <KeepChangesCard
                  changes={keepChangeLines(chat.keep, (gadgetId) => outputTitle([...chat.items, ...chat.pinned], gadgetId), (gadgetId, name) => keepBindings.get(bindingKey(gadgetId, name)))}
                  reason={keepReason(chat.keep)}
                  onKeep={actions.keepChanges}
                  onDiscard={() => void actions.discardChanges()}
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
            : gone
              ? <span role="status" className="text-sm text-kumo-subtle">This chat was deleted.</span>
              : <span role="status" className="appears-late text-sm text-kumo-subtle">Loading conversation…</span>}
        </MessageList>
      )}
      {/* Only while it is open, as what it says is read afresh for it. */}
      {outOfCredits && <OutOfCredits onClose={() => setCreditsShown({ open: false, seen: ranOut })} />}
      {/* Only while it is open, as what it lists is read afresh for it. */}
      {adding && (
        <AddConnection workspaceId={workspaceId} open={adding} onOpenChange={setAdding} to="this chat" onAdded={onAdded} />
      )}
      {deleteDialog}
    </ChatLayout>
  )
}
