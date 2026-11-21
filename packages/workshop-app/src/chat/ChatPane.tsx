import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { ChatHeader } from '@/blocks/ChatHeader'
import { Composer, type ComposerHandle } from '@/blocks/Composer'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import type { ComposerConnection } from '@/blocks/ComposerConnectionLines'
import { AddConnection, type AddedConnection } from '@/connections/AddConnection'
import type { CreationAction } from '@/connections/ApproveCreation'
import { KeepChangesCard } from '@/blocks/KeepChangesCard'
import { LiveRows } from '@/blocks/LiveRows'
import { MessageBubble } from '@/blocks/MessageBubble'
import { MessageList, type MessageListHandle } from '@/blocks/MessageList'
import { UserMessage } from '@/blocks/UserMessage'
import { WorkLog } from '@/blocks/WorkLog'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useHandler } from '@/hooks/useHandler'
import { useLiveWorkOpen } from '@/hooks/useLiveWorkOpen'
import { ChatLayout } from '@/layouts/ChatLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { OutOfCredits } from '@/settings/OutOfCredits'
import { messageOf } from '@/settings/useAttempt'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { ChatContextPanel } from './ChatContextPanel'
import { ChatContextSide } from './ChatContextSide'
import { chatContextOf, contextCount } from './chatContext'
import { useContextOpen } from './useContextOpen'
import { useNarrowScreen } from '@gadgets/ui'
import { ChatItemView, type ChatItemHandlers } from './ChatItemView'
import { continuesRun, EMPTY_FEED, outOfCreditsAt, type ChatAttachment, type ChatItem, type HookItem, type OutputItem } from './chatItems'
import { DisclosureStore, useOpenKeys } from './DisclosureStore'
import { keepChangeLines, keepReason } from './keepChanges'
import { bindingKey, useBindingTitles } from './useBindingTitles'
import { useGadgetTitles, type GadgetTitle } from './useGadgetTitles'
import type { ProposedChanges } from './proposedChanges'
import type { KeepAsk } from './ChatSession'
import { quoteLine, withQuote } from './replyQuote'
import { ChatStatusLine } from './ChatStatusLine'
import { describeModelProblem, useDefaultModel } from './useDefaultModel'
import { slashRequestFor, missingCommand } from './slashCommands'
import { useChatCommands } from './useChatCommands'
import { withCapsules } from './capsules'
import { useLinkConnections } from './useLinkConnections'
import { ConnectResource } from '@/connections/SetUpConnection'
import { useChatSession } from './useChatSession'
import { useOpenNewOutputs } from './useOpenNewOutputs'
import { useCapturedLogs } from './useCapturedLogs'
import { firstMessageOf } from './firstMessage'
import { useGadgetAgents } from '@/automations/useGadgetAgents'
import { CapturedLogsChip } from '@/blocks/CapturedLogsChip'

export type ChatPaneProps = {
  workspaceId: string
  chatId: number
  /** The title to show until the chat's own arrives, e.g. from the list it was opened from. */
  initialTitle?: string
  /** Goes to the page of the workspace the chat is in. */
  onOpenWorkspace: () => void
  /** Goes to the page of the agent whose run the chat is, or that its gadgets start, by its key. */
  onOpenAgent?: (agentKey: string) => void
  /** Goes to the workspace's Agents, for the several the chat's gadgets start. */
  onOpenAgents?: () => void
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
  /** Goes to where an automation the chat set up is listed, from the card of what the chat has, and where that is. Left out, they only say what they are. */
  onOpenAutomation?: (hook: HookItem) => void
  automationHref?: (hook: HookItem) => string
  onSetUpConnection?: ChatItemHandlers['onSetUpConnection']
  onAlwaysApprove?: ChatItemHandlers['onAlwaysApprove']
  /**
   * Approves an action that creates something (`ActionItem.creation`), asking where. Left out,
   * it is approved as any other, which the workspace refuses. Rejects with why it was not made.
   */
  onApproveCreation?: (action: CreationAction) => Promise<void>
  /**
   * The chat was deleted, here or by anyone else in the workspace: go somewhere else, in place of
   * it in the history, so that going back does not come back to it.
   */
  onDeleted: () => void
}

// A gadget's output, where the chat shows one.
const outputOf = (items: readonly ChatItem[], gadgetId: number) =>
  items.find((item): item is OutputItem => item.kind === 'output' && item.workpieceId === gadgetId)

// A gadget by the title the chat shows its output under, where it shows one.
const outputTitle = (items: readonly ChatItem[], gadgetId: number) => outputOf(items, gadgetId)?.title

/** One chat, live: its title, the messages as they arrive, and the composer. */
const NO_BINDINGS: { gadgetId: number; name: string }[] = []
const NO_IDS: number[] = []
// What is asked about is opened to as a row is, kept as the conversation's own rows are: each
// ask afresh, folded, once the changes asked about before are kept.
const keepKey = ({ epoch }: KeepAsk) => `keep:${epoch ?? ''}`

// Every gadget a chat's waiting changes are about, and what they reach.
const keptGadgetIds = ({ created, edited, bindings, updates }: ProposedChanges) => [
  ...created.map(({ gadgetId }) => gadgetId), ...edited, ...bindings.flatMap(({ gadgetId, target }) => [gadgetId, target]), ...updates.map(({ gadgetId }) => gadgetId),
]

// The gadgets the changes are to, each once: those made, then changed, updated, and given something.
const keptApps = ({ created, edited, updates, bindings }: ProposedChanges): number[] =>
  [...new Set([...created.map(({ gadgetId }) => gadgetId), ...edited, ...updates.map(({ gadgetId }) => gadgetId), ...bindings.map(({ gadgetId }) => gadgetId)])]

// A gadget the changes are to by the title the conversation shows it under, else the workspace
// has it by, else the changes gave it.
const keptTitle = (output: OutputItem | undefined, known: GadgetTitle | undefined, changes: ProposedChanges, gadgetId: number) =>
  output?.title ?? known?.title ?? changes.created.find((made) => made.gadgetId === gadgetId)?.title

// A gadget the changes are about, as an output to show, as its row in the conversation has it
// where it has one, else a draft where the changes make it.
const keptOutput = (items: readonly ChatItem[], changes: ProposedChanges, gadgetId: number, title: string | undefined): OutputItem =>
  outputOf(items, gadgetId)
    ?? { kind: 'output', id: 0, key: `keep-${gadgetId}`, workpieceId: gadgetId, title: title ?? 'Untitled', type: 'gadget', draft: changes.created.some((made) => made.gadgetId === gadgetId) }

export const ChatPane = ({ workspaceId, chatId, initialTitle, onOpenWorkspace, onOpenAgent, onOpenAgents, onOpenSettings, onOpenAttachment, onOpenOutput, outputHref, onOpenAutomation, automationHref, onSetUpConnection, onAlwaysApprove, onApproveCreation, onDeleted }: ChatPaneProps) => {
  const { chat, actions } = useChatSession(workspaceId, chatId)
  // What the bindings it waits to keep reach, by the names people know them by.
  const keeping = chat.status === 'ready' ? chat.keep?.changes : undefined
  const keepBindings = useBindingTitles(workspaceId, chatId, keeping?.bindings ?? NO_BINDINGS)
  // The gadgets they change that the conversation does not name, by the titles the workspace has.
  const keepGadgets = useGadgetTitles(workspaceId, keeping ? keptGadgetIds(keeping) : NO_IDS)
  // The apps they are to, named, each opened from them.
  const keepApps = chat.status === 'ready' && keeping
    ? keptApps(keeping).map((gadgetId) => {
      const output = outputOf([...chat.items, ...chat.pinned], gadgetId)
      const known = keepGadgets.get(gadgetId)
      return {
        gadgetId,
        title: keptTitle(output, known, keeping, gadgetId),
        icon: output?.format?.icon ?? known?.icon,
        files: keeping.files[gadgetId],
      }
    })
    : []

  const model = useDefaultModel()
  const workspaces = useWorkspaces()
  const connection = useConnectionNotice()
  // Why the last message could not be sent, when it never reached the conversation.
  const [problem, setProblem] = useState<string>()
  // What a row asked for that this app cannot do yet.
  const [notice, setNotice] = useState<string>()
  const [disclosure] = useState(() => new DisclosureStore())
  // The message the draft replies to: its row, its sequence, and the line of it that will be quoted.
  const [reply, setReply] = useState<{ key: string; sequence: number; quote: string }>()
  const composer = useRef<ComposerHandle>(null)
  const list = useRef<MessageListHandle>(null)
  const [sentFirst] = useState(() => firstMessageOf(workspaceId, chatId))
  const work = chat.status === 'ready' ? chat.work : EMPTY_FEED.work
  // Shown or put away for every chat at once, and kept: developer mode turns it on (`writeDevMode`).
  const [liveWorkOpen, setLiveWorkOpen] = useLiveWorkOpen()
  const openWork = useOpenKeys(disclosure, work.map(({ key }) => key))
  const keepKeys = useMemo(() => (chat.status === 'ready' && chat.keep ? [keepKey(chat.keep)] : []), [chat])
  const keepOpen = useOpenKeys(disclosure, keepKeys)
  const title = (chat.status === 'ready' ? chat.title : undefined) ?? initialTitle
  const items = chat.status === 'ready' ? chat.items : undefined
  // What the chat's cards show it set up to run by itself and was not deleted, for the header's clock.
  const pinned = chat.status === 'ready' ? chat.pinned : undefined
  // The agents the chat's gadgets start, for the header, read again as each turn ends.
  const gadgetIds = useMemo(() => (items ?? []).flatMap((item) => (item.kind === 'output' && item.type === 'gadget' ? [item.workpieceId] : [])), [items])
  const turns = useRef(0)
  const idle = chat.status === 'ready' && chat.activity === undefined
  const lastIdle = useRef(idle)
  if (idle !== lastIdle.current) {
    lastIdle.current = idle
    if (idle) turns.current += 1
  }
  const gadgetAgents = useGadgetAgents(workspaceId, chatId, gadgetIds, turns.current)
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
  const links = useLinkConnections(builds ? workspaceId : undefined, composer, added)
  const draftLinks = links?.draft
  const linkForm = links?.form
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

  // Shown, the workspace keeps the model's cache of the chat warm and tells the viewer of what is
  // new in it (`ChatSession.view`), for as long as it is on screen. Before marking it read below,
  // as coming to it starts over what was marked.
  useEffect(() => {
    if (builds) return actions.view()
  }, [actions, builds])
  // What is on screen has been read: each message that arrives while the tab is in view, and
  // what came while it was away once it is back.
  const latestRow = items?.at(-1)?.id
  useEffect(() => {
    if (!builds) return
    const markIfShown = () => document.visibilityState === 'visible' && actions.markRead()
    markIfShown()
    document.addEventListener('visibilitychange', markIfShown)
    return () => document.removeEventListener('visibilitychange', markIfShown)
  }, [actions, builds, latestRow])
  const commands = useChatCommands(workspaceId, actions.listCommands, chat.status === 'ready')
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
      rawMessage: actions.rawMessage,
      onMarkUnread: builds ? (item) => {
        setNotice(undefined)
        if (connection?.blocked()) return
        actions.markUnreadFrom(item.id).catch((error: unknown) => setNotice(`Couldn’t mark the chat unread: ${messageOf(error)}`))
      } : undefined,
      onReply: (item) => {
        setReply({ key: item.key, sequence: item.id, quote: quoteLine(item) })
        composer.current?.focus()
      },
      // The message may have had to be fetched. The list has its row by the next frame.
      onShowQuoted: (replying) => void actions.findReplied(replying).then((key) => {
        if (key) requestAnimationFrame(() => list.current?.scrollToMessage(key))
      }),
      onOpenAttachment: onOpenAttachment ?? unavailable('Previewing attachments'),
      loadAttachment: actions.attachmentContent,
      onOpenOutput: onOpenOutput ?? unavailable('Opening outputs'),
      outputHref,
      onApprove: (action) => {
        const { creation } = action
        if (!creation || !onApproveCreation) return actions.approveAction(action.actionId)
        return onApproveCreation({ actionId: action.actionId, title: action.title, gatekeeperId: creation.gatekeeperId }).catch((error: unknown) => setNotice(messageOf(error)))
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
  }, [actions, builds, connection, model, onOpenAttachment, onOpenOutput, outputHref, onSetUpConnection, onAlwaysApprove, onApproveCreation, sendSuggestion])


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
    const sent = await actions.send(request ?? written, model.id, files, capsules.length ? capsules : undefined, replied?.sequence)
    // Unless another message has been chosen to reply to meanwhile.
    if (sent) setReply((current) => (current === replied ? undefined : current))
    return sent
  })

  // The header and the composer are drawn again only for what they show. The chat renders for
  // every piece of a reply that streams in, and they are most of what it would draw again then.
  const ready = chat.status === 'ready'
  const openSettings = useHandler(() => onOpenSettings?.())
  const openWorkspace = useHandler(onOpenWorkspace)
  // The agent whose run it is, by what the header shows of it, so that each update does not draw it again.
  const agentKey = ready ? chat.agent?.key : undefined
  const agentName = ready ? chat.agent?.name : undefined
  const openAgent = useHandler(() => agentKey !== undefined && onOpenAgent?.(agentKey))
  // A run's own agent is its crumb already.
  const startsAgents = gadgetAgents.filter(({ key }) => key !== agentKey)
  const agentNames = startsAgents.map(({ name }) => name).join('\n')
  const firstAgentKey = startsAgents[0]?.key
  const several = startsAgents.length > 1
  const openStarted = useHandler(() => (several ? onOpenAgents?.() : firstAgentKey !== undefined && onOpenAgent?.(firstAgentKey)))
  const hasAgentPage = onOpenAgent !== undefined
  const hasSettings = onOpenSettings !== undefined
  const workspaceTitle = workspace?.title
  const header = useMemo(() => (workspaceTitle !== undefined || title) && (
    <ChatHeader
      workspace={workspaceTitle !== undefined ? { id: workspaceId, title: workspaceTitle, label: workspaceLabel(workspaceTitle), look, onOpen: openWorkspace } : undefined}
      agent={agentKey !== undefined && agentName !== undefined ? { agentKey, name: agentName, onOpen: hasAgentPage ? openAgent : undefined } : undefined}
      title={title}
      onOpenSettings={hasSettings ? () => openSettings() : undefined}
      agents={agentNames ? { names: agentNames.split('\n'), onOpen: openStarted } : undefined}
    />
  ), [agentNames, openStarted, workspaceTitle, agentKey, agentName, openAgent, hasAgentPage, title, workspaceId, look, openWorkspace, hasSettings, openSettings])

  // What the chat has, at the end of its header while it has any, where there is room for it beside the conversation.
  const artifacts = chat.status === 'ready' ? chat.artifacts : undefined
  const context = useMemo(() => chatContextOf(artifacts, [...(items ?? []), ...(pinned ?? [])]), [artifacts, items, pinned])
  const hasContext = contextCount(context) > 0
  const [contextOpen, changeContextOpen] = useContextOpen()
  // Not on a phone, where the conversation has the screen to itself.
  const narrow = useNarrowScreen()
  const openOutput = useHandler((output: OutputItem) => handlers.onOpenOutput(output))
  const openAttachment = useHandler((file: ChatAttachment) => handlers.onOpenAttachment(file))
  const openAutomation = useHandler((hook: HookItem) => onOpenAutomation?.(hook))
  const hrefOfAutomation = useHandler((hook: HookItem) => automationHref?.(hook) ?? '')
  const linksAutomations = automationHref !== undefined
  const opensAutomations = onOpenAutomation !== undefined
  // Beside the conversation, the button and the card take turns being there: focus goes from one to the other.
  const contextButton = useRef<HTMLButtonElement>(null)
  const contextMinimize = useRef<HTMLButtonElement>(null)
  const changeContext = useHandler((open: boolean) => {
    changeContextOpen(open)
    requestAnimationFrame(() => (open ? contextMinimize : contextButton).current?.focus({ preventScroll: true }))
  })
  const minimizeContext = useHandler(() => changeContext(false))
  const headerEnd = useCallback((room: 'beside' | 'floating') => (
    <ChatContextPanel
      workspaceId={workspaceId}
      context={context}
      open={contextOpen}
      onOpenChange={changeContext}
      floating={room === 'floating'}
      triggerRef={contextButton}
      onOpenOutput={openOutput}
      onOpenAttachment={openAttachment}
      outputHref={outputHref}
      onOpenAutomation={opensAutomations ? openAutomation : undefined}
      automationHref={linksAutomations ? hrefOfAutomation : undefined}
    />
  ), [workspaceId, context, contextOpen, changeContext, openOutput, openAttachment, outputHref, opensAutomations, openAutomation, linksAutomations, hrefOfAutomation])
  const contextSide = useMemo(() => (
    <ChatContextSide
      workspaceId={workspaceId}
      context={context}
      onMinimize={minimizeContext}
      minimizeRef={contextMinimize}
      onOpenOutput={openOutput}
      onOpenAttachment={openAttachment}
      outputHref={outputHref}
      onOpenAutomation={opensAutomations ? openAutomation : undefined}
      automationHref={linksAutomations ? hrefOfAutomation : undefined}
    />
  ), [workspaceId, context, minimizeContext, openOutput, openAttachment, outputHref, opensAutomations, openAutomation, linksAutomations, hrefOfAutomation])

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
  const usage = ready ? chat.usage : undefined
  const modelId = model.status === 'ready' ? model.id : undefined
  const agentActive = ready && chat.agentActive
  const waiting = ready ? chat.waiting : undefined
  const composerCommands = commands.commands
  const commandsLoading = commands.loading
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
      commandsLoading={commandsLoading}
      links={draftLinks}
      addActions={builds ? { onAddConnection: () => setAdding(true) } : undefined}
      stop={agentActive && waiting ? { waiting, onStop: stopAgent } : undefined}
      problem={sendProblem === undefined ? undefined : { message: sendProblem, onDismiss: dismissProblem }}
      reply={reply && { quote: reply.quote, onShow: showReplied, onCancel: () => setReply(undefined) }}
    />
    <ChatStatusLine usage={usage} modelId={modelId} />
    </div>
  ), [usage, modelId, logged, peekLogs, discardLogs, addLogs, sendMessage, composerCommands, commandsLoading, draftLinks, builds, agentActive, waiting, stopAgent, sendProblem, dismissProblem, reply, showReplied])

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
      headerEnd={hasContext && !narrow ? headerEnd : undefined}
      side={hasContext && !narrow ? contextSide : undefined}
      sideOpen={hasContext && contextOpen && !narrow}
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
                  changes={keepChangeLines(chat.keep, (gadgetId) => outputTitle([...chat.items, ...chat.pinned], gadgetId) ?? keepGadgets.get(gadgetId)?.title, (gadgetId, name) => keepBindings.get(bindingKey(gadgetId, name)))}
                  reason={keepReason(chat.keep)}
                  onKeep={actions.keepChanges}
                  sending={chat.keep.sending}
                  onDiscard={() => void actions.discardChanges()}
                  apps={keepApps}
                  onOpen={onOpenOutput && keeping ? (gadgetId) => onOpenOutput(keptOutput([...chat.items, ...chat.pinned], keeping, gadgetId, keepApps.find((app) => app.gadgetId === gadgetId)?.title)) : undefined}
                  open={keepOpen.has(keepKey(chat.keep))}
                  onToggle={() => chat.keep && disclosure.toggle(keepKey(chat.keep))}
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
              open: liveWorkOpen,
              onToggle: () => setLiveWorkOpen(!liveWorkOpen),
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
              : sentFirst
                // Just sent from the page before, drawn as it was there while the history is read.
                ? <><UserMessage {...sentFirst} /><AssistantPresence working status="Thinking…" /></>
                : <span role="status" className="appears-late text-sm text-kumo-subtle">Loading conversation…</span>}
        </MessageList>
      )}
      {/* Only while it is open, as what it says is read afresh for it. */}
      {outOfCredits && <OutOfCredits onClose={() => setCreditsShown({ open: false, seen: ranOut })} />}
      {/* Only while it is open, as what it lists is read afresh for it. */}
      {adding && (
        <AddConnection workspaceId={workspaceId} open={adding} onOpenChange={setAdding} to="this chat" onAdded={onAdded} />
      )}
      {linkForm && <ConnectResource {...linkForm} />}
    </ChatLayout>
  )
}
